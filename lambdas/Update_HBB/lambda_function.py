"""PATCH /business  ->  update the logged-in owner's storefront.

Body: any of {"name", "description", "phone", "email", "website", "accent", "price", "tag",
              "category", "address" + "postalCode", "imageUrl", "websiteLabel", "note", "hours", "items"}
"websiteLabel" (27 Oct) is the text shown for the website link. "imageUrl" is a link to an online photo.
"hours" is the weekly opening hours, e.g. {"mon": [["09:00", "12:00"], ["14:00", "17:00"]]}; days left out are closed.
"hoursMode" (23 Oct) is "regular" (use "hours") or "irregular" (use "dates": {"2026-10-24": [["10:00", "14:00"]]}).
"businessType" (23 Oct) is "product" (customers order, then collect) or "service" (by appointment).
"note" is the owner's message shown as "A note from <name>" on the storefront.
"items" is what the business sells, up to 6 keys from common.ITEMS (the older way, still accepted).
"products" (22 Oct) is the owner's own list, up to 12: [{"name", "description"?}]. Each one is matched by its
wording to the closest ITEMS types (common.match_product) and saved with them, and "items" is set to
the types they cover, so the recommender keeps working for products that aren't in ITEMS.
An empty price ("") leaves the current price unchanged.
Reply 200: {"business"}

Shut down (28 Oct): {"shutDown": true, "confirmName": "<the business name>"} removes the listing for good.
Open bookings from today on are cancelled with a note to the customer, and the owner's account goes back to
a customer account (they can register a business again later). Past visits and payments are kept.
Reply 200: {"shutDown": true, "user"}
"""
from common import (Key, appointments, booking_message, now_iso, public_user, query_all, today, users,
                    BUSINESS_TYPES, CATEGORIES, HOURS_MODES, opening_dates, opening_hours, EMAIL_RE, HEX_RE, Attr, HttpError, address_fields, amount,
                    businesses, handler, item_list, items_from_products, json_body, owner_business,
                    product_list, require_business_owner, text, update_fields)

TEXT_LIMITS = {"name": 80}


@handler
def lambda_handler(event, context):
    user, business_id = require_business_owner(event)
    data = json_body(event)
    if data.get("shutDown") is True:
        return _shut_down(user, business_id, data)
    changes = {}

    for key, limit in TEXT_LIMITS.items():
        if key in data:
            changes[key] = text(data, key, max_len=limit)
    if "tag" in data:
        changes["tag"] = text(data, "tag", required=False, max_len=80)
    if "phone" in data:
        changes["phone"] = text(data, "phone", required=False, max_len=30)
    if "hours" in data:
        changes["hours"] = opening_hours(data["hours"])
    if "dates" in data:
        changes["dates"] = opening_dates(data["dates"])
    if "hoursMode" in data:
        if data["hoursMode"] not in HOURS_MODES:
            raise HttpError(400, "hoursMode must be regular or irregular.")
        changes["hoursMode"] = data["hoursMode"]
    if "businessType" in data:
        if data["businessType"] not in BUSINESS_TYPES:
            raise HttpError(400, "Please choose Product or Service.")
        changes["businessType"] = data["businessType"]
    if "items" in data:
        changes["items"] = item_list(data["items"])
    if "products" in data:
        category = data.get("category") or (businesses().get_item(Key={"businessId": business_id}).get("Item") or {}).get("category", "")
        changes["products"] = product_list(data["products"], category)
        if not changes["products"]:   # 27 Oct: the menu can't be saved empty
            raise HttpError(400, "Add at least one product or service to your menu before saving.")
        changes["items"] = items_from_products(changes["products"])
    if "websiteLabel" in data:
        changes["websiteLabel"] = text(data, "websiteLabel", required=False, max_len=40)
    if "note" in data:
        changes["note"] = text(data, "note", required=False, max_len=300)
    if "description" in data:
        changes["description"] = text(data, "description", required=False, max_len=1000)
    if "email" in data:
        email = text(data, "email", max_len=254).lower()
        if not EMAIL_RE.match(email):
            raise HttpError(400, "Please enter a valid business email.")
        changes["email"] = email
    for key in ("website", "imageUrl"):
        if key in data:
            value = text(data, key, required=False, max_len=500)
            if value and not value.startswith(("http://", "https://")):
                raise HttpError(400, "Please use an http or https address.")
            changes[key] = value
    if "accent" in data:
        if not isinstance(data["accent"], str) or not HEX_RE.match(data["accent"]):
            raise HttpError(400, "The brand colour must look like #2d6650.")
        changes["accent"] = data["accent"]
    if "price" in data and data["price"] not in ("", None):
        changes["price"] = amount(data, "price")
    if "category" in data:
        if data["category"] not in CATEGORIES:
            raise HttpError(400, "Please choose a category.")
        changes["category"] = data["category"]
    if "address" in data or "postalCode" in data:
        changes.update(address_fields(data))

    if not changes:
        raise HttpError(400, "Nothing to update.")
    item = update_fields(businesses(), {"businessId": business_id}, changes,
                         condition=Attr("businessId").exists())
    return 200, {"business": owner_business(item)}


def _shut_down(user, business_id, data):
    business = businesses().get_item(Key={"businessId": business_id}).get("Item") or {}
    name = business.get("name", "")
    if str(data.get("confirmName", "")).strip().casefold() != name.strip().casefold():
        raise HttpError(400, f"Type your business name, {name}, to confirm.")
    # Customers' open bookings from today on are cancelled, so nobody turns up at a closed business
    note = f"{name or 'This business'} has closed on The Grove, so this booking is cancelled."
    at = now_iso()
    for appt in query_all(appointments(), IndexName="businessId-date-index",
                          KeyConditionExpression=Key("businessId").eq(business_id) & Key("date").gte(today()),
                          FilterExpression=Attr("status").eq("Pending") | Attr("status").eq("Confirmed")):
        appointments().update_item(
            Key={"appointmentId": appt["appointmentId"]},
            UpdateExpression="SET #s = :s, awaiting = :e, messages = list_append(if_not_exists(messages, :none), :m), "
                             "lastActivityAt = :at, seenOwnerAt = :at",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": "Cancelled", ":e": "", ":none": [], ":at": at,
                                       ":m": [booking_message("owner", name, "cancel", note)]})
    businesses().delete_item(Key={"businessId": business_id})
    updated = users().update_item(Key={"userId": user["userId"]}, UpdateExpression="SET isBusiness = :f REMOVE businessId",
                                  ExpressionAttributeValues={":f": False}, ReturnValues="ALL_NEW")["Attributes"]
    return 200, {"shutDown": True, "user": public_user(updated)}
