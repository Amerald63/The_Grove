"""
Shared helpers for every Grove Lambda function.

Deploy this file next to each function's lambda_function.py (the build script in
tools/build_lambdas.sh does that for you), or publish it once as a Lambda Layer.

Environment variables (set on every function):
  USERS_TABLE           default "Users"
  BUSINESSES_TABLE      default "HomeBusinesses"
  TRANSACTIONS_TABLE    default "Transactions"
  CHAIN_TABLE           default "Chain_Sessions"
  APPOINTMENTS_TABLE    default "Appointments"
  JWT_SECRET            required: a long random string, the same on every function
  ALLOWED_ORIGIN        default "*"  (set to your CloudFront / S3 site URL in production)
  CASHBACK_AMOUNT       default "1"  (S$ credited for every chain visit after the first)
  TOKEN_TTL_HOURS       default "168" (7 days)
  PBKDF2_ITERATIONS     default "150000"
  TZ_OFFSET_HOURS       default "8"  (Singapore)
"""
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
import traceback
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Attr, Key  # noqa: F401  (re-exported for handlers)

log = logging.getLogger()
log.setLevel(logging.INFO)

# --------------------------------------------------------------------------- tables
_resource = None


def ddb():
    global _resource
    if _resource is None:
        _resource = boto3.resource("dynamodb")
    return _resource


def _table(env_name, default):
    return ddb().Table(os.environ.get(env_name, default))


def users():
    return _table("USERS_TABLE", "Users")


def businesses():
    return _table("BUSINESSES_TABLE", "HomeBusinesses")


def transactions():
    return _table("TRANSACTIONS_TABLE", "Transactions")


def chains():
    return _table("CHAIN_TABLE", "Chain_Sessions")


def appointments():
    return _table("APPOINTMENTS_TABLE", "Appointments")


def query_all(table, **kwargs):
    """Query every page (DynamoDB returns at most 1 MB per call)."""
    items = []
    while True:
        page = table.query(**kwargs)
        items.extend(page.get("Items", []))
        if "LastEvaluatedKey" not in page:
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def scan_all(table, **kwargs):
    items = []
    while True:
        page = table.scan(**kwargs)
        items.extend(page.get("Items", []))
        if "LastEvaluatedKey" not in page:
            return items
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def update_fields(table, key, fields, condition=None):
    """SET each field in `fields` on the item at `key`; returns the updated item."""
    names, values, parts = {}, {}, []
    for i, (name, value) in enumerate(fields.items()):
        names[f"#f{i}"] = name
        values[f":f{i}"] = value
        parts.append(f"#f{i} = :f{i}")
    kwargs = dict(
        Key=key,
        UpdateExpression="SET " + ", ".join(parts),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
        ReturnValues="ALL_NEW",
    )
    if condition is not None:
        kwargs["ConditionExpression"] = condition
    return table.update_item(**kwargs)["Attributes"]


# --------------------------------------------------------------------------- http
class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def _plain(value):
    """Convert DynamoDB Decimals (and sets) into JSON-friendly values."""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_plain(v) for v in value]
    return value


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": os.environ.get("ALLOWED_ORIGIN", "*"),
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
        },
        "body": json.dumps(_plain(body)),
    }


def handler(fn):
    """Decorator: turns HttpError into a JSON error response and logs anything unexpected."""

    def wrapped(event, context):
        if method(event) == "OPTIONS":
            return respond(204, {})
        try:
            status, body = fn(event, context)
            return respond(status, body)
        except HttpError as err:
            return respond(err.status, {"message": err.message})
        except Exception:  # pragma: no cover - logged for CloudWatch
            log.error(traceback.format_exc())
            return respond(500, {"message": "Something went wrong on our side. Please try again."})

    return wrapped


def method(event):
    return (event.get("requestContext", {}).get("http", {}).get("method")  # HTTP API (v2)
            or event.get("httpMethod")                                       # REST API (v1)
            or "GET").upper()


def path(event):
    return event.get("rawPath") or event.get("path") or ""


def path_param(event, name):
    value = (event.get("pathParameters") or {}).get(name)
    if not value:
        raise HttpError(400, f"Missing {name} in the URL.")
    return value


def json_body(event):
    raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(raw).decode("utf-8")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise HttpError(400, "The request body must be JSON.")
    if not isinstance(data, dict):
        raise HttpError(400, "The request body must be a JSON object.")
    return data


def _header(event, name):
    for k, v in (event.get("headers") or {}).items():
        if k.lower() == name.lower():
            return v
    return None


# --------------------------------------------------------------------------- validation
REGIONS = ["North", "South", "East", "West", "Central"]
# Asked right after sign-up (27 Oct) so business Insights show who their customers are. Optional.
GENDERS = ["Female", "Male"]   # Male and Female only (27 Oct); anything older counts as not shared
AGE_GROUPS = ["Under 18", "18–24", "25–34", "35–44", "45–54", "55–64", "65+", "Prefer not to say"]
# Since 27 Oct pm customers give their age as a number; Insights groups it into AGE_GROUPS.


def age_group(user):
    """The AGE_GROUPS bucket for a user's age (or an older saved ageGroup); None when not shared."""
    age = user.get("age")
    if age is None:
        return user.get("ageGroup") or None
    age = int(age)
    for top, label in ((17, "Under 18"), (24, "18–24"), (34, "25–34"), (44, "35–44"), (54, "45–54"), (64, "55–64")):
        if age <= top:
            return label
    return "65+"
CATEGORIES = ["Food & Beverage", "Health & Beauty", "Arts & Crafts", "Fashion & Accessories"]
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def text(data, key, *, required=True, max_len=200, default=""):
    value = data.get(key)
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            raise HttpError(400, f"Please provide {key}.")
        return default
    if not isinstance(value, str):
        raise HttpError(400, f"{key} must be text.")
    value = value.strip()
    if len(value) > max_len:
        raise HttpError(400, f"{key} must be {max_len} characters or fewer.")
    return value


def amount(data, key, *, required=True, minimum=Decimal("0")):
    value = data.get(key)
    if value is None or value == "":
        if required:
            raise HttpError(400, f"Please provide {key}.")
        return None
    try:
        dec = Decimal(str(value)).quantize(Decimal("0.01"))
    except Exception:
        raise HttpError(400, f"{key} must be a number.")
    if dec < minimum or dec > Decimal("1000000"):
        raise HttpError(400, f"{key} is out of range.")
    return dec


def coordinate(data, key, low, high):
    value = data.get(key)
    if value is None or value == "":
        return None
    try:
        dec = Decimal(str(value))
    except Exception:
        raise HttpError(400, f"{key} must be a number.")
    if not (Decimal(str(low)) <= dec <= Decimal(str(high))):
        raise HttpError(400, f"{key} must be inside Singapore.")
    return dec


# --------------------------------------------------------------------------- items (recommendations, 21 Oct)
# The 24 items the recommender knows, from Amos's preference-hybrid model (hbb_model v13).
# key: (label shown on the site, category)
ITEMS = {
    "matcha_latte": ("Matcha latte", "Food & Beverage"),
    "coffee": ("Coffee", "Food & Beverage"),
    "tea": ("Tea", "Food & Beverage"),
    "cookies": ("Cookies", "Food & Beverage"),
    "brownies": ("Brownies", "Food & Beverage"),
    "home_cooked_meal": ("Home-cooked meal", "Food & Beverage"),
    "custom_tshirt": ("Custom T-shirt", "Fashion & Accessories"),
    "crochet_keychain": ("Crochet keychain", "Fashion & Accessories"),
    "handmade_jewellery": ("Handmade jewellery", "Fashion & Accessories"),
    "stickers": ("Stickers", "Arts & Crafts"),
    "scented_candle": ("Scented candle", "Arts & Crafts"),
    "pottery_workshop": ("Pottery workshop", "Arts & Crafts"),
    "flower_bouquet": ("Flower bouquet", "Arts & Crafts"),
    "personalised_gift_box": ("Personalised gift box", "Arts & Crafts"),
    "flower_arranging_workshop": ("Flower arranging workshop", "Arts & Crafts"),
    "preserved_flowers": ("Preserved flowers", "Arts & Crafts"),
    "greeting_card": ("Greeting card", "Arts & Crafts"),
    "crochet_flower_bouquet": ("Crochet flower bouquet", "Arts & Crafts"),
    "manicure": ("Manicure", "Health & Beauty"),
    "facial": ("Facial", "Health & Beauty"),
    "eyelash_extensions": ("Eyelash extensions", "Health & Beauty"),
    "eyebrow_grooming": ("Eyebrow grooming", "Health & Beauty"),
    "hair_styling": ("Hair styling", "Health & Beauty"),
    "yoga_session": ("Yoga session", "Health & Beauty"),
}
MAX_BUSINESS_ITEMS = 6
TRAVEL_MODES = ("near", "anywhere")   # near = within 5 km
# Words that show a business sells an item, for listings whose owner hasn't picked items yet
# (same keyword list as hbb_model's legacy_model.ALIASES).
ITEM_KEYWORDS = {
    "matcha_latte": ["matcha"], "coffee": ["coffee", "espresso", "kopi"], "tea": ["tea", "hojicha"],
    "cookies": ["cookie"], "brownies": ["brownie"],
    "home_cooked_meal": ["home cooked", "home-cooked", "meal", "sandwich", "mantou"],
    "custom_tshirt": ["t-shirt", "tshirt", "tees", "shirt"], "stickers": ["sticker"],
    "crochet_keychain": ["crochet keychain", "keychain"],
    "handmade_jewellery": ["jewellery", "jewelry", "earring", "necklace", "brooch"],
    "scented_candle": ["candle"], "pottery_workshop": ["pottery", "ceramic"],
    "flower_bouquet": ["bouquet", "florist"], "personalised_gift_box": ["gift box", "personalised gift"],
    "flower_arranging_workshop": ["flower arranging", "floral workshop"],
    "preserved_flowers": ["preserved flower"], "greeting_card": ["greeting card"],
    "crochet_flower_bouquet": ["crochet flower"], "manicure": ["nail", "manicure"],
    "facial": ["facial", "skincare"], "eyelash_extensions": ["lash"], "eyebrow_grooming": ["brow"],
    "hair_styling": ["hair styling", "hairstyl", "haircut", "hair salon"], "yoga_session": ["yoga"],
}


# --------------------------------------------------------------------------- products: auto-matching
# Owners type their own products (name + a few words). Each one is matched by its wording to the
# closest ITEMS types, e.g. "Hojicha Basque cheesecake" -> tea 40%, brownies 40%, cookies 20%.
# The recommender then scores the product through those types, so it needs no other change.
# Words: word -> weight (1 = a clear sign, 0.5 = a hint). Multi-word phrases count once per word.
TYPE_WORDS = {
    "matcha_latte": {"matcha": 1, "latte": 0.5, "green tea latte": 1},
    "coffee": {"coffee": 1, "kopi": 1, "espresso": 1, "latte": 0.5, "cappuccino": 1, "americano": 1, "mocha": 1,
               "cold brew": 1, "flat white": 1, "barista": 0.5, "beans": 0.5, "cafe": 0.5},
    "tea": {"tea": 1, "hojicha": 1, "chai": 1, "oolong": 1, "earl grey": 1, "milk tea": 1, "bubble tea": 1, "boba": 1,
            "teh": 1, "herbal": 0.5, "tisane": 1, "kombucha": 1, "matcha": 0.3},
    "cookies": {"cookie": 1, "biscuit": 1, "shortbread": 1, "macaron": 1, "pineapple tart": 1, "tart": 0.5,
                "muffin": 1, "cupcake": 0.5, "croissant": 0.5, "pastry": 0.5, "bake": 0.5, "baked": 0.5, "bakes": 0.5,
                "dessert": 0.5, "cake": 0.5, "cheesecake": 0.5, "kueh": 1, "kuih": 1, "snack": 0.5, "bread": 0.5,
                "ondeh": 1, "onde": 1, "kaya": 0.5, "lapis": 1, "nonya": 0.5, "nyonya": 0.5, "waffle": 1,
                "sourdough": 0.5, "scone": 1, "granola": 0.5},
    "brownies": {"brownie": 1, "blondie": 1, "cake": 1, "cheesecake": 1, "chocolate": 1, "fudge": 1, "lava": 0.5,
                 "dessert": 0.5, "cupcake": 0.5, "pastry": 0.5, "bake": 0.5, "baked": 0.5, "tart": 0.5, "tiramisu": 1,
                 "pudding": 0.5},
    "home_cooked_meal": {"meal": 1, "rice": 1, "noodle": 1, "curry": 1, "nasi": 1, "lemak": 1, "bento": 1, "lunch": 1,
                         "dinner": 1, "sandwich": 1, "mantou": 1, "bun": 0.5, "dumpling": 1, "soup": 1, "pasta": 1,
                         "laksa": 1, "chicken": 0.5, "porridge": 1, "catering": 1, "home cooked": 1, "homecooked": 1,
                         "food": 0.5, "bao": 1, "sourdough": 0.5, "bread": 0.5, "frozen": 0.5, "sambal": 1,
                         "toast": 1, "kaya": 0.5, "egg": 0.5, "rendang": 1, "satay": 1, "prata": 1, "dim sum": 1},
    "custom_tshirt": {"t-shirt": 1, "tshirt": 1, "tee": 1, "shirt": 1, "apparel": 1, "hoodie": 1, "tote": 0.5,
                      "clothing": 1, "clothes": 1, "embroidery": 0.5, "embroidered": 0.5, "printed": 0.5, "custom": 0.3},
    "crochet_keychain": {"keychain": 1, "key chain": 1, "crochet": 0.6, "amigurumi": 1, "plush": 1, "plushie": 1,
                         "bag charm": 1, "charm": 0.5, "knit": 0.5, "knitted": 0.5, "yarn": 0.5},
    "handmade_jewellery": {"jewellery": 1, "jewelry": 1, "earring": 1, "necklace": 1, "bracelet": 1, "ring": 1,
                           "brooch": 1, "pendant": 1, "bead": 1, "beaded": 1, "anklet": 1, "charm": 0.5,
                           "accessory": 0.5, "accessories": 0.5, "silver": 0.5, "resin": 0.5},
    "stickers": {"sticker": 1, "decal": 1, "washi": 1, "illustration": 1, "art print": 1, "print": 0.5, "zine": 1,
                 "bookmark": 1, "postcard": 0.5, "doodle": 0.5, "drawing": 0.5},
    "scented_candle": {"candle": 1, "wax": 1, "soy": 0.5, "scent": 1, "scented": 1, "fragrance": 1, "diffuser": 1,
                       "aroma": 1, "incense": 1, "soap": 0.5, "essential oil": 1},
    "pottery_workshop": {"pottery": 1, "ceramic": 1, "clay": 1, "mug": 0.5, "vase": 0.5, "wheel": 0.5, "glaze": 1,
                         "workshop": 0.3, "class": 0.3},
    "flower_bouquet": {"bouquet": 1, "flower": 1, "floral": 1, "florist": 1, "rose": 1, "tulip": 1, "bloom": 1,
                       "posy": 1, "sunflower": 1, "fresh flower": 1},
    "personalised_gift_box": {"gift": 1, "hamper": 1, "gift box": 1, "personalised": 1, "personalized": 1,
                              "engraved": 1, "box": 0.3, "present": 1, "custom": 0.3, "party favour": 1},
    "flower_arranging_workshop": {"arranging": 1, "ikebana": 1, "floral workshop": 1, "flower workshop": 1,
                                  "workshop": 0.3, "class": 0.3},
    "preserved_flowers": {"preserved": 1, "dried flower": 1, "dried": 0.5, "everlasting": 1, "pressed flower": 1,
                          "terrarium": 1},
    "greeting_card": {"card": 1, "greeting": 1, "postcard": 0.5, "invitation": 1, "calligraphy": 1,
                      "stationery": 1, "letter": 0.5, "envelope": 0.5},
    "crochet_flower_bouquet": {"crochet flower": 1, "crochet bouquet": 1, "yarn flower": 1, "knitted flower": 1,
                               "crochet": 0.8, "bouquet": 0.5},
    "manicure": {"nail": 1, "manicure": 1, "pedicure": 1, "gel": 0.5, "polish": 0.5, "nail art": 1},
    "facial": {"facial": 1, "skincare": 1, "skin": 1, "mask": 0.5, "peel": 0.5, "acne": 1, "glow": 0.5,
               "serum": 0.5, "spa": 0.5, "massage": 0.5},
    "eyelash_extensions": {"lash": 1, "eyelash": 1, "lash lift": 1, "extension": 0.5},
    "eyebrow_grooming": {"brow": 1, "eyebrow": 1, "threading": 1, "microblading": 1, "waxing": 0.5},
    "hair_styling": {"hair": 1, "haircut": 1, "styling": 0.5, "blowout": 1, "perm": 1, "colouring": 1, "braid": 1,
                     "salon": 1, "barber": 1, "trim": 0.5},
    "yoga_session": {"yoga": 1, "pilates": 1, "stretch": 1, "stretching": 1, "meditation": 1, "wellness": 0.5,
                     "fitness": 1, "breathwork": 1, "class": 0.3},
}
MAX_PRODUCTS = 200   # no real cap (23 Oct); only keeps a business row well under DynamoDB's 400 KB item limit
_WORD_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")


def _forms(word):
    """A word and its likely singular forms: cookies -> cookie, pastries -> pastry, boxes -> box."""
    forms = {word}
    if len(word) > 3 and word.endswith("ies"):
        forms.add(word[:-3] + "y")
    if len(word) > 3 and word.endswith("es"):
        forms.add(word[:-2])
    if len(word) > 2 and word.endswith("s"):
        forms.add(word[:-1])
    return forms


def _hits(words, text_value):
    """Sum of the weights of `words` that appear in the text (whole words or phrases)."""
    tokens = _WORD_RE.findall(text_value.lower())
    singles = set()
    for t in tokens:
        singles |= _forms(t)
    plain = " " + " ".join(tokens) + " "
    single = " " + " ".join(min(_forms(t), key=len) for t in tokens) + " "   # "dried flowers" -> "dried flower"
    total = 0.0
    for word, weight in words.items():
        if " " in word:
            if f" {word} " in plain or f" {word} " in single:
                total += weight * len(word.split())
        elif word in singles:
            total += weight
    return total


def match_product(name, description="", category=""):
    """{item type: share} for a product, best matches first; {} when nothing matches.
    The name counts twice as much as the description, and its last word (what the product is,
    e.g. "earrings") once more; types in the business's own category get a small boost; matches under a quarter of the best one are dropped; up to 3 are kept."""
    raw = {}
    name_words = _WORD_RE.findall((name or "").lower())
    head = name_words[-1] if name_words else ""   # "Polymer clay earrings": the last word says what it is
    for item, words in TYPE_WORDS.items():
        score = 2 * _hits(words, name) + _hits(words, description or "") + _hits(words, head)
        label = ITEMS[item][0].lower()
        if f" {label} " in f" {' '.join(_WORD_RE.findall((name or '').lower()))} ":
            score += 3   # the product is literally called e.g. "Crochet keychain"
        if score and ITEMS[item][1] == category:
            score *= 1.25
        if score:
            raw[item] = score
    if not raw:
        return {}
    best = max(raw.values())
    kept = sorted((i for i in raw if raw[i] >= best / 4), key=lambda i: -raw[i])[:3]
    total = sum(raw[i] for i in kept)
    return {i: round(raw[i] / total, 2) for i in kept}


def product_list(value, category=""):
    """The owner's own products: [{"name", "description", "price", "types": {item: share}}], up to MAX_PRODUCTS.
    Price (S$) is required from 23 Oct: customers tick products and the site works out what they spent."""
    if not isinstance(value, list):
        raise HttpError(400, "products must be a list.")
    if len(value) > MAX_PRODUCTS:
        raise HttpError(400, f"Add up to {MAX_PRODUCTS} products.")
    out, seen = [], set()
    for entry in value:
        if not isinstance(entry, dict):
            raise HttpError(400, "Each product needs a name.")
        name = text(entry, "name", max_len=60)
        description = text(entry, "description", required=False, max_len=200)
        if entry.get("price") in (None, ""):
            raise HttpError(400, f"Please give {name} a price.")
        price = amount(entry, "price")
        if name.lower() in seen:
            continue
        seen.add(name.lower())
        types = match_product(name, description, category)
        out.append({"name": name, "description": description, "price": price, "types": types,
                    "matchedBy": "words" if types else ""})
    fill_unmatched(out, category)
    for p in out:
        p["types"] = {k: Decimal(str(v)) for k, v in p["types"].items()}
    return out


def fill_unmatched(products, category):
    """(23 Oct) Give every product a place in the recommender, even one no word list knows ("Mystery item").
    A product that matched nothing borrows the mix of the shop's other matched products ("shop"),
    else an equal share of every type in the business's category ("category").
    Changes the list in place; products that already have types are left alone."""
    mix = {}
    for p in products:
        for k, v in (p.get("types") or {}).items():
            mix[k] = mix.get(k, 0) + float(v)
    if mix:
        kept = sorted(mix, key=lambda k: -mix[k])[:3]
        total = sum(mix[k] for k in kept)
        fallback, how = {k: round(mix[k] / total, 2) for k in kept}, "shop"
    else:
        same = [k for k, (_, c) in ITEMS.items() if c == category]
        fallback, how = ({k: round(1 / len(same), 2) for k in same}, "category") if same else ({}, "")
    for p in products:
        if not p.get("types"):
            p["types"], p["matchedBy"] = dict(fallback), how


MAX_QUANTITY = 99


def order_lines(business, value):
    """What a customer ticked: [{"name", "quantity"}] -> ([{"name", "quantity", "price", "item"}], total).
    Prices come from the business's own product list, never from the request.
    `item` is the product's best-matched ITEMS type ("" if it matched nothing)."""
    if not isinstance(value, list) or not value:
        raise HttpError(400, "Please tick at least one product.")
    priced = {p.get("name"): p for p in business.get("products") or [] if p.get("price") is not None}
    lines, total, seen = [], Decimal("0"), set()
    for entry in value:
        name = entry.get("name") if isinstance(entry, dict) else None
        if name not in priced or name in seen:
            raise HttpError(400, "That product isn't on this business's list any more. Please refresh the page.")
        seen.add(name)
        quantity = entry.get("quantity")
        if not isinstance(quantity, int) or isinstance(quantity, bool) or not 1 <= quantity <= MAX_QUANTITY:
            raise HttpError(400, f"Quantity must be a whole number from 1 to {MAX_QUANTITY}.")
        product = priced[name]
        types = product.get("types") or {}
        item = max(types, key=lambda k: types[k]) if types else ""
        price = Decimal(str(product["price"]))
        lines.append({"name": name, "quantity": quantity, "price": price, "item": item})
        total += price * quantity
    return lines, total.quantize(Decimal("0.01"))


def main_item(lines):
    """The ITEMS type that best describes an order, for the recommender: the type of the line that cost the most."""
    typed = [l for l in lines if l.get("item")]
    return max(typed, key=lambda l: Decimal(str(l["price"])) * l["quantity"])["item"] if typed else ""


def items_from_products(products):
    """The ITEMS types a list of products covers, best match of each product first.
    A product placed only by its category says nothing about what the shop sells, so it is skipped."""
    items = []
    for p in products:
        if p.get("matchedBy") == "category":
            continue
        for item in p.get("types") or {}:
            if item not in items:
                items.append(item)
    return items


def business_products(business):
    """What a business sells, as [{"name", "types": {item: share}}] for the recommender:
    its own matched products, else the items the owner picked, else a guess from its listing.
    Products no word list knows borrow the shop's other products, else their category (fill_unmatched)."""
    own = [{"name": p.get("name", ""), "types": {k: float(v) for k, v in (p.get("types") or {}).items() if k in ITEMS}}
           for p in business.get("products") or []]
    fill_unmatched(own, business.get("category", ""))   # products saved before 23 Oct may have no types
    own = [p for p in own if p["types"]]
    if own:
        return own
    return [{"name": "", "types": {i: 1.0}} for i in business_items(business)]


def business_items(business):
    """The items a business sells: the owner's own list, or a guess from its listing text."""
    if business.get("items"):
        return [i for i in business["items"] if i in ITEMS]
    words = " ".join(str(business.get(k) or "") for k in ("name", "tag", "description")).lower()
    return [i for i, keys in ITEM_KEYWORDS.items() if any(k in words for k in keys)]


def item_key(data, key):
    value = data.get(key)
    if value not in ITEMS:
        raise HttpError(400, "Please choose an item from the list.")
    return value


def item_list(value, limit=MAX_BUSINESS_ITEMS):
    if not isinstance(value, list) or not all(v in ITEMS for v in value):
        raise HttpError(400, "Please choose items from the list.")
    items = list(dict.fromkeys(value))
    if len(items) > limit:
        raise HttpError(400, f"Choose up to {limit} items.")
    return items


def item_ratings(value):
    """{item: 1-5} for the items the customer has rated; others are left out."""
    if not isinstance(value, dict):
        raise HttpError(400, "Ratings must list items and scores.")
    ratings = {}
    for item, score in value.items():
        if item not in ITEMS:
            raise HttpError(400, f"Unknown item: {item}.")
        if not isinstance(score, int) or isinstance(score, bool) or not 1 <= score <= 5:
            raise HttpError(400, "Each rating must be a whole number from 1 to 5.")
        ratings[item] = score
    return ratings


def boolean(data, key):
    value = data.get(key)
    if not isinstance(value, bool):
        raise HttpError(400, f"{key} must be true or false.")
    return value


# --------------------------------------------------------------------------- time
def _tz():
    return timezone(timedelta(hours=float(os.environ.get("TZ_OFFSET_HOURS", "8"))))


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def today():
    return datetime.now(_tz()).strftime("%Y-%m-%d")


def new_id():
    return str(uuid.uuid4())


def cashback_amount():
    return Decimal(os.environ.get("CASHBACK_AMOUNT", "1"))


# --------------------------------------------------------------------------- passwords
def hash_password(password, salt=None, iterations=None):
    iterations = iterations or int(os.environ.get("PBKDF2_ITERATIONS", "150000"))
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), iterations)
    return f"pbkdf2_sha256${iterations}${salt}${digest.hex()}"


def check_password(password, stored):
    try:
        _, iterations, salt, _ = stored.split("$")
    except (ValueError, AttributeError):
        return False
    return hmac.compare_digest(hash_password(password, salt, int(iterations)), stored)


# --------------------------------------------------------------------------- tokens (HS256 JWT)
def _b64(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _unb64(text_value):
    return base64.urlsafe_b64decode(text_value + "=" * (-len(text_value) % 4))


def _secret():
    secret = os.environ.get("JWT_SECRET")
    if not secret:
        raise RuntimeError("JWT_SECRET is not set on this Lambda function.")
    return secret.encode("utf-8")


def make_token(user_id, email):
    now = int(time.time())
    header = _b64(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    payload = _b64(json.dumps({
        "sub": user_id,
        "email": email,
        "iat": now,
        "exp": now + int(float(os.environ.get("TOKEN_TTL_HOURS", "168")) * 3600),
    }, separators=(",", ":")).encode())
    signature = _b64(hmac.new(_secret(), f"{header}.{payload}".encode(), hashlib.sha256).digest())
    return f"{header}.{payload}.{signature}"


def verify_token(token):
    """Return the token payload, or None if the token is invalid or expired."""
    try:
        header, payload, signature = token.split(".")
        expected = _b64(hmac.new(_secret(), f"{header}.{payload}".encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(expected, signature):
            return None
        claims = json.loads(_unb64(payload))
        if claims.get("exp", 0) < time.time():
            return None
        return claims
    except Exception:
        return None


def require_user_id(event):
    """User id from the API Gateway authorizer context, or from the Bearer token itself."""
    auth = event.get("requestContext", {}).get("authorizer") or {}
    user_id = (auth.get("lambda") or {}).get("userId") or auth.get("userId")
    if user_id:
        return user_id
    header = _header(event, "Authorization") or ""
    if header.startswith("Bearer "):
        claims = verify_token(header[7:].strip())
        if claims and claims.get("sub"):
            return claims["sub"]
    raise HttpError(401, "Please log in again.")


def require_user(event):
    user = users().get_item(Key={"userId": require_user_id(event)}).get("Item")
    if not user:
        raise HttpError(401, "Please log in again.")
    return user


def require_business_owner(event):
    user = require_user(event)
    if not user.get("businessId"):
        raise HttpError(403, "Register your business first.")
    return user, user["businessId"]


# --------------------------------------------------------------------------- public shapes
USER_FIELDS = ["userId", "email", "name", "phone", "region", "interests", "reminders",
               "recommendations", "itemRatings", "travel", "isBusiness", "businessId",
               "cashbackBalance", "createdAt", "gender", "ageGroup", "age"]
BUSINESS_FIELDS = ["businessId", "name", "category", "area", "region", "lat", "lng", "price",
                   "imageUrl", "tag", "description", "ownerName", "phone", "email", "website",
                   "accent", "note", "hours", "hoursMode", "dates", "businessType",
                   "items", "products", "rating", "reviews", "createdAt", "websiteLabel", "reviewList"]
MAX_REVIEW_TEXT = 500


def public_user(item):
    shown = {k: item.get(k) for k in USER_FIELDS if k in item}
    if item.get("userId"):
        shown["reviewKey"] = review_key(item["userId"])   # finds your own review on a storefront (27 Oct)
    return shown


def review_key(user_id):
    """Who wrote a review, without showing their userId: the site compares it with its own (27 Oct)."""
    return hashlib.sha256(f"review:{user_id}".encode()).hexdigest()[:16]


def public_business(item):
    shown = {k: item.get(k) for k in BUSINESS_FIELDS if k in item}
    # Reviews (27 Oct) are kept as {userId: review}, one per customer; the listing shows them newest first
    if isinstance(shown.get("reviewList"), dict):
        shown["reviewList"] = sorted(shown["reviewList"].values(), key=lambda r: r.get("at", ""), reverse=True)
    return shown


def owner_business(item):
    """What the owner sees: the public listing plus the private home address."""
    shown = public_business(item)
    for k in ("address", "postalCode"):
        if k in item:
            shown[k] = item[k]
    return shown


# --------------------------------------------------------------------------- postal codes
# Singapore postal districts, keyed by the first two digits of the postal code (the sector).
# Gives each home business an area name, a region and an approximate map position without
# publishing the exact address.
_DISTRICTS = [
    # (sectors, area, region, lat, lng)
    ("01 02 03 04 05 06", "Raffles Place / Marina", "South", 1.2840, 103.8510),
    ("07 08", "Tanjong Pagar", "South", 1.2765, 103.8455),
    ("14 15 16", "Queenstown / Tiong Bahru", "South", 1.2900, 103.8100),
    ("09 10", "Telok Blangah / Harbourfront", "South", 1.2700, 103.8200),
    ("11 12 13", "Pasir Panjang / Clementi", "West", 1.3100, 103.7650),
    ("17", "Beach Road / High Street", "Central", 1.2930, 103.8530),
    ("18 19", "Bugis / Golden Mile", "Central", 1.3000, 103.8580),
    ("20 21", "Little India / Farrer Park", "Central", 1.3070, 103.8520),
    ("22 23", "Orchard / River Valley", "Central", 1.3040, 103.8320),
    ("24 25 26 27", "Bukit Timah / Holland / Tanglin", "Central", 1.3150, 103.8000),
    ("28 29 30", "Novena / Thomson", "Central", 1.3250, 103.8400),
    ("31 32 33", "Balestier / Toa Payoh", "Central", 1.3330, 103.8500),
    ("34 35 36 37", "MacPherson / Braddell", "Central", 1.3350, 103.8800),
    ("38 39 40 41", "Geylang / Eunos", "East", 1.3180, 103.8900),
    ("42 43 44 45", "Katong / Joo Chiat", "East", 1.3050, 103.9050),
    ("46 47 48", "Bedok / Upper East Coast", "East", 1.3240, 103.9300),
    ("49 50 81", "Loyang / Changi", "East", 1.3600, 103.9750),
    ("51 52", "Tampines / Pasir Ris", "East", 1.3600, 103.9500),
    ("53 54 55 82", "Serangoon / Hougang / Punggol", "East", 1.3700, 103.8900),
    ("56 57", "Bishan / Ang Mo Kio", "Central", 1.3600, 103.8450),
    ("58 59", "Upper Bukit Timah / Clementi Park", "West", 1.3400, 103.7750),
    ("60 61 62 63 64", "Jurong", "West", 1.3400, 103.7200),
    ("65 66 67 68", "Bukit Panjang / Choa Chu Kang", "West", 1.3800, 103.7600),
    ("69 70 71", "Lim Chu Kang / Tengah", "West", 1.4000, 103.7100),
    ("72 73", "Kranji / Woodlands", "North", 1.4350, 103.7850),
    ("77 78", "Upper Thomson / Springleaf", "North", 1.3900, 103.8250),
    ("75 76", "Yishun / Sembawang", "North", 1.4300, 103.8350),
    ("79 80", "Seletar", "North", 1.4050, 103.8700),
]
_SECTORS = {sector: row[1:] for row in _DISTRICTS for sector in row[0].split()}
POSTAL_RE = re.compile(r"^\d{6}$")


def locate_postal(postal_code):
    """(area, region, lat, lng) for a Singapore postal code, or None if it isn't one."""
    if not isinstance(postal_code, str) or not POSTAL_RE.match(postal_code.strip()):
        return None
    found = _SECTORS.get(postal_code.strip()[:2])
    if not found:
        return None
    area, region, lat, lng = found
    return area, region, Decimal(str(lat)), Decimal(str(lng))


def address_fields(data):
    """Validated {address, postalCode, area, region, lat, lng} from a request body."""
    if not str(data.get("address") or "").strip():
        raise HttpError(400, "Please enter your home business address.")
    address = text(data, "address", max_len=200)
    postal = str(data.get("postalCode") or "").strip()
    located = locate_postal(postal)
    if not located:
        raise HttpError(400, "Please enter a valid 6-digit Singapore postal code.")
    area, region, lat, lng = located
    return {"address": address, "postalCode": postal, "area": area, "region": region, "lat": lat, "lng": lng}


def chain_is_current(session):
    """True for an active chain started today (Singapore time). Chains end at midnight even when the
    Nightly_Reset schedule didn't run (for example, the Learner Lab was off at 23:59)."""
    if not session or session.get("status") != "active":
        return False
    try:
        started = datetime.fromisoformat(str(session.get("startedAt") or "")).astimezone(_tz()).strftime("%Y-%m-%d")
    except ValueError:
        return True
    return started >= today()


def public_chain(item):
    if not chain_is_current(item):
        return None
    return {k: item.get(k) for k in ["sessionId", "businessIds", "totalCashback", "startedAt"]}


# --------------------------------------------------------------------------- bookings
# A booking takes one 30-minute slot. Pending and Confirmed bookings both hold their slot.
SLOT_MINUTES = 30
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
HOLDING = ("Pending", "Confirmed")
BOOKING_TYPES = ("visit", "pickup")


def _minutes(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


# Opening hours (23 Oct): a day can have several open spans, e.g. 9:00–12:00 and 14:00–17:00.
#   hoursMode "regular":   "hours" = {"mon": [["09:00", "12:00"], ["14:00", "17:00"]], ...}; days left out are closed.
#   hoursMode "irregular": "dates" = {"2026-10-24": [["10:00", "14:00"]], ...}; dates left out are closed.
# Older listings saved one span per day, {"mon": ["09:00", "17:00"]}; every reader accepts both shapes.
HOURS_MODES = ("regular", "irregular")
MAX_DATES = 120          # irregular dates kept, from today on
BUSINESS_TYPES = ("product", "service")


def _span_list(raw):
    """[[from, to], ...] from either shape (or [] for a closed day)."""
    if not raw:
        return []
    if isinstance(raw, list) and len(raw) == 2 and all(isinstance(t, str) for t in raw):
        return [list(raw)]
    return [list(x) for x in raw if isinstance(x, (list, tuple)) and len(x) == 2]


def _clean_spans(raw, where):
    """Validate one day's spans; overlapping or touching spans are merged. "24:00" closes at midnight."""
    spans = []
    for span in _span_list(raw):
        if not all(isinstance(t, str) and (TIME_RE.match(t) or t == "24:00") for t in span):
            raise HttpError(400, f"Please give an opening and closing time for {where}.")
        start, end = _minutes(span[0]), _minutes(span[1])
        if start % SLOT_MINUTES or end % SLOT_MINUTES:
            raise HttpError(400, "Opening hours must be on the hour or half hour.")
        if end <= start:
            raise HttpError(400, f"Closing time must be after opening time ({where}).")
        spans.append([start, end])
    merged = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    return [[_hhmm(a), _hhmm(b)] for a, b in merged]


def _hhmm(minutes):
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def opening_hours(value):
    """Validate the weekly hours, {"mon": [[from, to], ...]} (or the older {"mon": [from, to]})."""
    if not isinstance(value, dict):
        raise HttpError(400, "Opening hours must list each open day.")
    hours = {}
    for day, raw in value.items():
        if day not in DAYS:
            raise HttpError(400, f"Unknown day: {day}.")
        spans = _clean_spans(raw, day)
        if spans:
            hours[day] = spans
    return hours


def opening_dates(value):
    """Validate the irregular schedule, {"2026-10-24": [[from, to], ...]}. Past dates are dropped."""
    if not isinstance(value, dict):
        raise HttpError(400, "Opening dates must list each open date.")
    out = {}
    for day, raw in sorted(value.items()):
        if not isinstance(day, str) or not DATE_RE.match(day):
            raise HttpError(400, "Opening dates must look like 2026-10-24.")
        try:
            datetime.strptime(day, "%Y-%m-%d")
        except ValueError:
            raise HttpError(400, f"{day} isn't a real date.")
        if day < today():
            continue
        spans = _clean_spans(raw, day)
        if spans:
            out[day] = spans
    if len(out) > MAX_DATES:
        raise HttpError(400, f"Set up to {MAX_DATES} open dates ahead.")
    return out


def spans_on(business, day):
    """The open spans [[from, to], ...] of a business on one date ("2026-10-24")."""
    if business.get("hoursMode") == "irregular":
        return _span_list((business.get("dates") or {}).get(day))
    weekday = DAYS[datetime.strptime(day, "%Y-%m-%d").weekday()]
    return _span_list((business.get("hours") or {}).get(weekday))


def takes_bookings(business):
    """True once a business has any opening hours (irregular: an open date from today on)."""
    if business.get("hoursMode") == "irregular":
        return any(d >= today() and _span_list(v) for d, v in (business.get("dates") or {}).items())
    return any(_span_list(v) for v in (business.get("hours") or {}).values())


def business_type(business):
    """"service" (by appointment; a visit is logged after it) or "product" (order, then collect).
    Listings from before 23 Oct have none: Health & Beauty counts as a service, the rest as products."""
    kind = business.get("businessType")
    if kind in BUSINESS_TYPES:
        return kind
    return "service" if business.get("category") == "Health & Beauty" else "product"


def holding_bookings(business_id, appt_date):
    """Bookings on that day that hold a slot (Pending or Confirmed)."""
    return query_all(appointments(), IndexName="businessId-date-index",
                     KeyConditionExpression=Key("businessId").eq(business_id) & Key("date").eq(appt_date),
                     FilterExpression=Attr("status").eq("Pending") | Attr("status").eq("Confirmed"))


def customer_clash(user_id, appt_date, appt_time, exclude_id=None):
    """The customer's own open booking (Pending or Confirmed, at any business) in the same 30-minute slot, or None.
    28 Oct: a customer can't be booked at two places at once."""
    for a in query_all(appointments(), IndexName="userId-date-index",
                       KeyConditionExpression=Key("customerUserId").eq(user_id) & Key("date").eq(appt_date),
                       FilterExpression=Attr("status").eq("Pending") | Attr("status").eq("Confirmed")):
        if a.get("time") == appt_time and a.get("appointmentId") != exclude_id:
            return a
    return None


def clash_message(a):
    hh, mm = (int(x) for x in a["time"].split(":"))
    when = f"{(hh % 12) or 12}:{mm:02d}{'am' if hh < 12 else 'pm'}"
    return f"You already have a booking at {a.get('businessName') or 'another business'} at {when} that day. Please pick another time."


def check_slot(business, appt_date, appt_time, *, exclude_id=None, check_hours=True, exclusive=True):
    """Raise HttpError unless the 30-minute slot can be booked.
    exclusive=False (order pickups): several customers can collect in the same half hour."""
    if not DATE_RE.match(appt_date or "") or not TIME_RE.match(appt_time or ""):
        raise HttpError(400, "Please choose a valid date and time.")
    try:
        day = DAYS[datetime.strptime(appt_date, "%Y-%m-%d").weekday()]
    except ValueError:
        raise HttpError(400, "Please choose a valid date.")
    if appt_date < today() or (appt_date == today() and appt_time <= datetime.now(_tz()).strftime("%H:%M")):
        raise HttpError(400, "Please choose a time that hasn't passed yet.")
    if _minutes(appt_time) % SLOT_MINUTES:
        raise HttpError(400, "Please choose a time on the hour or half hour.")
    if check_hours:
        if not takes_bookings(business):
            raise HttpError(400, "This business isn't taking bookings yet.")
        start = _minutes(appt_time)
        if not any(_minutes(a) <= start <= _minutes(b) - SLOT_MINUTES for a, b in spans_on(business, appt_date)):
            raise HttpError(400, "That time is outside the business's opening hours.")
    if not exclusive:
        return
    for other in holding_bookings(business["businessId"], appt_date):
        if other.get("time") == appt_time and other.get("appointmentId") != exclude_id:
            raise HttpError(409, "That time is already booked. Please choose another time.")


def booking_message(by, name, kind, text_value="", change=None):
    """One entry in a booking's conversation. kind: request|message|change|confirm|decline|cancel."""
    msg = {"by": by, "name": name or "", "kind": kind, "text": text_value or "", "at": now_iso()}
    if change:
        msg["change"] = change
    return msg
