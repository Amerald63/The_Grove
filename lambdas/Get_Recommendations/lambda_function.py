"""GET /recommendations  ->  the logged-in customer's next stops: businesses picked by the item model.

Query (all optional):
    lat, lng   the customer's location (after "Use my location"); otherwise their region's centre
    at         visit time "YYYY-MM-DDTHH:MM", Singapore time; default now
Reply 200: up to 60 businesses, best first: {"recommendations": [{"rank", "item", "label", "score", "inChain",
                                 "business": {"businessId", "name", "area", "category", "imageUrl"},
                                 "distanceKm", "openNow", "closesAt" | "opensAt" | "hoursUnknown"}],
            "parent", "travel", "basis": "ratings" | "interests"}
           {"recommendations": [], "off": true} when the customer turned recommendations off.
  item = the type that put the business there; product = the owner's own product name, when it came from one.

The model is Amos's preference hybrid (hbb_model v13, preference_model.py), unchanged:
    score(item) = 0.8 x own-rating share + 0.2 x smoothed "what people buy next" share
  - own-rating share: (rating - 1) / 4, divided by the total over every item not bought yet.
    Ratings come from Settings -> Your tastes; unrated items count 4 if they're in one of the
    customer's interests, otherwise 2.
  - "what people buy next": after the customer's last purchase (the parent), how often other
    customers bought each item next. alpha = n / (n + 10) mixes it with overall popularity when
    there are only n examples. Evidence = the 500 synthetic customers from hbb_model (SEED_TRANSITIONS)
    plus every purchase other customers log on the site, so it learns as visits come in.
  - Items the customer already bought are never recommended. Other items in the same category are.
Then every business in range ("near" customers: within 5 km; never the customer's own) is placed by
the best-scoring product it sells. Owners type their own products; each is auto-matched by its wording
to ITEMS types (common.match_product, e.g. "Hojicha Basque cheesecake" -> tea 40%, brownies 40%,
cookies 20%) and scores the share-weighted sum of those types' scores. Businesses without products use
the items the owner picked, else a guess from its listing, else every item in its category (so a
brand-new business still shows up). A single-type product scores exactly its item, so the order is the
same as before for businesses that sell catalog items. The list comes in three parts:
  1. open now and new to the customer (visiting earns cash back),
  2. new but not open now (opens later, or no opening hours set),
  3. already in the customer's chain or visited before (no cash back; inChain = true), open ones first.
Each part keeps the model's order, then explicit items before guesses, then the nearest.
The best items of the businesses returned are saved on the user as lastRecommendations, so
New_Transaction can record where a later purchase was in them (recommendationRank 1-12, live Hit@K).
"""
import math
from datetime import datetime, timedelta

from common import (DAYS, ITEMS, Attr, HttpError, Key, _tz, business_products, businesses, chains,
                    coordinate, handler, now_iso, query_all, require_user, scan_all, transactions,
                    update_fields, users, spans_on, takes_bookings, chain_is_current)

PREFERENCE_WEIGHT, PATTERN_WEIGHT, SHRINKAGE = 0.8, 0.2, 10
TOP = 60   # the site shows 3 at a time; Refresh shows the next 3, so the later parts are reachable
NEAR_KM = 5
# Same region centres as the site's map (product-v8.js regionGeo)
REGION_CENTRES = {"North": (1.435, 103.80), "South": (1.285, 103.82), "East": (1.35, 103.94),
                  "West": (1.355, 103.73), "Central": (1.355, 103.85)}

# bought_item -> next_purchase_item counts from hbb_model's 500 synthetic customers
# (data/synthetic_user_preferences(1).csv, rows where the next item differs from the last one).
SEED_TRANSITIONS = {
    "brownies": {"coffee": 3, "crochet_flower_bouquet": 1, "eyebrow_grooming": 2,
        "flower_arranging_workshop": 1, "hair_styling": 1, "manicure": 1, "matcha_latte": 1,
        "preserved_flowers": 1, "stickers": 1, "yoga_session": 1},
    "coffee": {"brownies": 7, "cookies": 3, "custom_tshirt": 1, "flower_bouquet": 1, "greeting_card": 2,
        "handmade_jewellery": 1, "manicure": 2, "stickers": 1},
    "cookies": {"brownies": 2, "coffee": 2, "crochet_flower_bouquet": 2, "crochet_keychain": 1,
        "eyebrow_grooming": 3, "eyelash_extensions": 3, "flower_bouquet": 1, "greeting_card": 1,
        "hair_styling": 1, "home_cooked_meal": 1, "manicure": 1, "matcha_latte": 5,
        "personalised_gift_box": 3, "pottery_workshop": 1, "stickers": 1, "tea": 1,
        "yoga_session": 1},
    "crochet_flower_bouquet": {"brownies": 2, "coffee": 2, "cookies": 1, "crochet_keychain": 3,
        "flower_arranging_workshop": 1, "flower_bouquet": 1, "greeting_card": 6, "hair_styling": 1,
        "handmade_jewellery": 1, "home_cooked_meal": 1, "manicure": 1, "pottery_workshop": 1,
        "scented_candle": 1, "tea": 1},
    "crochet_keychain": {"cookies": 1, "crochet_flower_bouquet": 4, "custom_tshirt": 1, "eyebrow_grooming": 2,
        "eyelash_extensions": 1, "facial": 2, "flower_bouquet": 1, "stickers": 5, "tea": 1},
    "custom_tshirt": {"coffee": 1, "cookies": 1, "crochet_keychain": 3, "eyebrow_grooming": 1, "facial": 1,
        "flower_arranging_workshop": 3, "handmade_jewellery": 1, "home_cooked_meal": 2,
        "manicure": 1, "matcha_latte": 2, "pottery_workshop": 2, "scented_candle": 1, "stickers": 7,
        "yoga_session": 2},
    "eyebrow_grooming": {"crochet_keychain": 1, "eyelash_extensions": 3, "facial": 1, "flower_arranging_workshop": 2,
        "home_cooked_meal": 2, "manicure": 2, "matcha_latte": 1, "pottery_workshop": 1,
        "preserved_flowers": 3, "scented_candle": 1, "stickers": 2, "tea": 2},
    "eyelash_extensions": {"crochet_keychain": 1, "custom_tshirt": 1, "eyebrow_grooming": 2, "facial": 1,
        "flower_arranging_workshop": 4, "flower_bouquet": 3, "handmade_jewellery": 2,
        "home_cooked_meal": 1, "manicure": 7, "pottery_workshop": 1, "preserved_flowers": 1,
        "scented_candle": 1, "stickers": 2, "yoga_session": 1},
    "facial": {"brownies": 1, "eyebrow_grooming": 4, "flower_bouquet": 2, "handmade_jewellery": 1,
        "pottery_workshop": 1, "preserved_flowers": 1, "stickers": 2, "yoga_session": 5},
    "flower_arranging_workshop": {"cookies": 1, "custom_tshirt": 2, "eyelash_extensions": 1, "facial": 1, "flower_bouquet": 2,
        "greeting_card": 1, "matcha_latte": 1, "personalised_gift_box": 2, "pottery_workshop": 1,
        "preserved_flowers": 2, "stickers": 2},
    "flower_bouquet": {"brownies": 1, "custom_tshirt": 2, "eyelash_extensions": 3, "facial": 1, "greeting_card": 6,
        "home_cooked_meal": 2, "manicure": 1, "matcha_latte": 2, "personalised_gift_box": 3,
        "pottery_workshop": 1, "stickers": 1, "tea": 1, "yoga_session": 2},
    "greeting_card": {"coffee": 1, "cookies": 1, "crochet_flower_bouquet": 2, "crochet_keychain": 1,
        "custom_tshirt": 3, "eyelash_extensions": 1, "facial": 1, "flower_bouquet": 3,
        "handmade_jewellery": 1, "matcha_latte": 1, "personalised_gift_box": 2,
        "preserved_flowers": 3, "tea": 1, "yoga_session": 1},
    "hair_styling": {"custom_tshirt": 1, "eyebrow_grooming": 1, "eyelash_extensions": 1,
        "flower_arranging_workshop": 1, "matcha_latte": 1, "scented_candle": 2, "tea": 1},
    "handmade_jewellery": {"brownies": 1, "coffee": 2, "crochet_keychain": 2, "eyebrow_grooming": 1, "facial": 1,
        "flower_bouquet": 2, "greeting_card": 2, "hair_styling": 2, "home_cooked_meal": 1,
        "manicure": 2, "matcha_latte": 1, "personalised_gift_box": 2, "pottery_workshop": 1},
    "home_cooked_meal": {"brownies": 5, "crochet_keychain": 1, "custom_tshirt": 1, "eyelash_extensions": 2,
        "greeting_card": 1, "hair_styling": 1, "handmade_jewellery": 3, "pottery_workshop": 2,
        "scented_candle": 1, "tea": 1},
    "manicure": {"brownies": 1, "coffee": 1, "crochet_flower_bouquet": 2, "crochet_keychain": 1,
        "eyelash_extensions": 6, "facial": 1, "greeting_card": 2, "hair_styling": 1,
        "handmade_jewellery": 2, "home_cooked_meal": 2, "pottery_workshop": 1, "stickers": 1},
    "matcha_latte": {"brownies": 4, "coffee": 1, "cookies": 7, "crochet_keychain": 2, "facial": 1,
        "flower_arranging_workshop": 1, "manicure": 2, "personalised_gift_box": 1, "stickers": 3,
        "tea": 1, "yoga_session": 1},
    "personalised_gift_box": {"brownies": 1, "coffee": 2, "cookies": 2, "custom_tshirt": 1, "eyebrow_grooming": 1,
        "facial": 2, "flower_bouquet": 4, "hair_styling": 1, "manicure": 2, "preserved_flowers": 4,
        "scented_candle": 2, "stickers": 1, "tea": 1, "yoga_session": 1},
    "pottery_workshop": {"brownies": 1, "coffee": 1, "cookies": 2, "crochet_flower_bouquet": 1, "custom_tshirt": 2,
        "eyelash_extensions": 1, "facial": 1, "flower_arranging_workshop": 3, "hair_styling": 1,
        "handmade_jewellery": 1, "home_cooked_meal": 2, "matcha_latte": 1,
        "personalised_gift_box": 2, "preserved_flowers": 2, "scented_candle": 1, "stickers": 1,
        "tea": 1},
    "preserved_flowers": {"coffee": 1, "cookies": 1, "custom_tshirt": 1, "eyelash_extensions": 1, "facial": 1,
        "flower_bouquet": 2, "greeting_card": 3, "matcha_latte": 2, "personalised_gift_box": 2,
        "pottery_workshop": 1, "scented_candle": 1, "tea": 1},
    "scented_candle": {"brownies": 1, "coffee": 1, "crochet_keychain": 2, "eyebrow_grooming": 1,
        "eyelash_extensions": 1, "facial": 1, "home_cooked_meal": 2, "manicure": 1,
        "matcha_latte": 2, "personalised_gift_box": 4, "yoga_session": 2},
    "stickers": {"coffee": 1, "cookies": 1, "crochet_keychain": 3, "custom_tshirt": 2, "eyebrow_grooming": 1,
        "eyelash_extensions": 1, "flower_bouquet": 3, "manicure": 1, "matcha_latte": 2,
        "preserved_flowers": 1, "scented_candle": 2},
    "tea": {"coffee": 1, "cookies": 2, "crochet_keychain": 1, "eyebrow_grooming": 2, "facial": 1,
        "flower_arranging_workshop": 2, "flower_bouquet": 1, "hair_styling": 1,
        "home_cooked_meal": 1, "scented_candle": 2, "stickers": 1, "yoga_session": 1},
    "yoga_session": {"coffee": 2, "cookies": 1, "eyelash_extensions": 1, "facial": 2,
        "flower_arranging_workshop": 2, "flower_bouquet": 1, "greeting_card": 1, "hair_styling": 1,
        "home_cooked_meal": 1, "matcha_latte": 3, "scented_candle": 2, "tea": 3},
}


# ---------------------------------------------------------------- purchase evidence
def _purchases(rows):
    """Items bought, oldest first, from a customer's visit transactions."""
    visits = sorted((r for r in rows if r.get("kind") == "visit" and r.get("item") in ITEMS),
                    key=lambda r: r.get("createdAt", ""))
    return [r["item"] for r in visits]


def transition_counts(exclude_user_id):
    """SEED_TRANSITIONS plus each step between consecutive purchases by other customers."""
    counts = {a: dict(nexts) for a, nexts in SEED_TRANSITIONS.items()}
    rows = scan_all(transactions(), FilterExpression=Attr("kind").eq("visit") & Attr("item").exists())
    by_customer = {}
    for r in rows:
        if r.get("customerUserId") and r["customerUserId"] != exclude_user_id:
            by_customer.setdefault(r["customerUserId"], []).append(r)
    for visits in by_customer.values():
        bought = _purchases(visits)
        for a, b in zip(bought, bought[1:]):
            if a != b:
                counts.setdefault(a, {})
                counts[a][b] = counts[a].get(b, 0) + 1
    return counts


# ---------------------------------------------------------------- the model
def _share(values):
    total = sum(values.values())
    return {k: (v / total if total else 0.0) for k, v in values.items()}


def item_scores(ratings, parent, bought, counts):
    """Amos's preference hybrid: 80% own ratings + 20% smoothed purchase patterns."""
    candidates = [i for i in ITEMS if i not in bought]
    overall = {}
    for nexts in counts.values():
        for item, n in nexts.items():
            overall[item] = overall.get(item, 0) + n
    total = sum(overall.values())
    group = counts.get(parent, {}) if parent else {}
    n = sum(group.values())
    alpha = n / (n + SHRINKAGE) if n else 0.0
    pattern = {i: alpha * (group.get(i, 0) / n if n else 0.0) + (1 - alpha) * (overall.get(i, 0) / total if total else 0.0)
               for i in candidates}
    preference = {i: max(0.0, (ratings[i] - 1) / 4) for i in candidates}
    preference, pattern = _share(preference), _share(pattern)
    return {i: PREFERENCE_WEIGHT * preference[i] + PATTERN_WEIGHT * pattern[i] for i in candidates}


def customer_ratings(user):
    saved = {k: int(v) for k, v in (user.get("itemRatings") or {}).items() if k in ITEMS}
    interests = set(user.get("interests") or [])
    ratings = {i: saved.get(i, 4 if ITEMS[i][1] in interests else 2) for i in ITEMS}
    return ratings, ("ratings" if saved else "interests")


# ---------------------------------------------------------------- businesses: hours and distance
def _at(hhmm, day):
    h, m = map(int, hhmm.split(":"))
    return day.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(hours=h, minutes=m)   # "24:00" = midnight


def opening(business, when):
    """("open", closes), ("later", its next opening in the coming week), or ("unknown", None) with no hours.
    Works for weekly hours with several spans a day and for irregular dates (common.spans_on)."""
    if not takes_bookings(business):
        return "unknown", None
    for ahead in range(0, 8):
        day = when + timedelta(days=ahead)
        for start, end in spans_on(business, day.strftime("%Y-%m-%d")):
            if ahead == 0 and _at(start, day) <= when < _at(end, day):
                return "open", _at(end, day)
            if _at(start, day) > when:
                return "later", _at(start, day)
    return "unknown", None


def distance_km(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (*a, *b))
    q = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(min(1.0, q)))


def _visit_time(params):
    raw = (params.get("at") or "").strip()
    if not raw:
        return datetime.now(_tz())
    try:
        return datetime.strptime(raw, "%Y-%m-%dT%H:%M").replace(tzinfo=_tz())
    except ValueError:
        raise HttpError(400, "at must look like 2026-10-21T14:00.")


def _clock(dt):
    return dt.strftime("%H:%M")


def _best_product(products, scores, position):
    """(score, the type that drove it, product name) for the business's best product, or None.
    A product scores the share-weighted sum of its types' scores; types already bought score 0."""
    best = None
    for p in products:
        live = {t: w for t, w in p["types"].items() if t in scores}
        if not live:
            continue
        score = sum(w * scores[t] for t, w in p["types"].items() if t in scores)
        lead = max(live, key=lambda t: (live[t] * scores[t], -position[t]))
        if best is None or score > best[0] or (score == best[0] and position[lead] < position[best[1]]):
            best = (score, lead, p["name"])
    return best


def _chain_business_ids(user):
    """Businesses in the customer's active chain: another visit there earns no cash back."""
    session_id = user.get("activeChainSessionId")
    session = chains().get_item(Key={"sessionId": session_id}).get("Item") if session_id else None
    return set(session.get("businessIds") or []) if chain_is_current(session) else set()


@handler
def lambda_handler(event, context):
    user = require_user(event)
    if user.get("recommendations") is False:
        return 200, {"recommendations": [], "off": True}
    params = event.get("queryStringParameters") or {}
    lat, lng = coordinate(params, "lat", 1.1, 1.5), coordinate(params, "lng", 103.5, 104.1)
    here = (float(lat), float(lng)) if lat is not None and lng is not None else REGION_CENTRES.get(user.get("region"), REGION_CENTRES["Central"])
    when = _visit_time(params)
    travel = user.get("travel") if user.get("travel") in ("near", "anywhere") else "anywhere"

    rows = query_all(transactions(), IndexName="userId-date-index",
                     KeyConditionExpression=Key("customerUserId").eq(user["userId"]))
    history = _purchases(rows)
    parent = history[-1] if history else ""
    ratings, basis = customer_ratings(user)
    scores = item_scores(ratings, parent, set(history), transition_counts(user["userId"]))
    ranked = sorted(scores, key=lambda i: (-scores[i], -ratings[i], i))
    position = {item: n for n, item in enumerate(ranked)}   # items already bought aren't ranked
    # Going back to these earns no cash back: the chain, and anywhere visited before
    been = _chain_business_ids(user) | {r.get("businessId") for r in rows if r.get("kind") == "visit"}

    # Every other business in range, placed by the best-ranked item it sells
    found = []
    for b in scan_all(businesses()):
        if b.get("ownerUserId") == user["userId"] or b.get("businessId") == user.get("businessId"):
            continue
        try:
            km = distance_km(here, (float(b["lat"]), float(b["lng"])))
        except (KeyError, TypeError, ValueError):
            km = None
        if travel == "near" and (km is None or km > NEAR_KM):
            continue
        products = business_products(b)
        guessed = not products   # nothing listed or matched: everything in its category
        if guessed:
            products = [{"name": "", "types": {i: 1.0}} for i, (_, category) in ITEMS.items() if category == b.get("category")]
        best = _best_product(products, scores, position)
        if best is None:
            continue           # sells only what the customer already bought
        status, at = opening(b, when)
        in_chain = b.get("businessId") in been
        section = 2 if in_chain else (0 if status == "open" else 1)
        score, item, product = best
        found.append(((section, status != "open", -score, position[item], guessed, km if km is not None else 999),
                      b, item, product, score, status, at, km, in_chain))
    # Open and new first, then new but not open now, then ones already in the chain; each in the model's order
    found.sort(key=lambda f: f[0])

    out = []
    for _, b, item, product, score, status, at, km, in_chain in found[:TOP]:
        rec = {"rank": len(out) + 1, "item": item, "label": product or ITEMS[item][0], "score": round(score, 4),
               "inChain": in_chain,
               "business": {k: b.get(k) for k in ("businessId", "name", "area", "category", "imageUrl")},
               "distanceKm": round(km, 1) if km is not None else None, "openNow": status == "open"}
        if product:
            rec["product"] = product
        if status == "open":
            rec["closesAt"] = _clock(at)
        elif status == "later":
            rec["opensAt"] = (at.strftime("%a ") if at.date() != when.date() else "") + _clock(at)
        else:
            rec["hoursUnknown"] = True
        out.append(rec)
    if out:
        update_fields(users(), {"userId": user["userId"]},
                      {"lastRecommendations": {"items": [r["item"] for r in out], "at": now_iso()}})
    return 200, {"recommendations": out, "parent": parent, "travel": travel, "basis": basis}
