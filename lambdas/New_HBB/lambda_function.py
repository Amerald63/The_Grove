"""POST /business  ->  register a home business for the logged-in user.

Body: {"name", "category", "businessType" ("product"|"service", 27 Oct), "address", "postalCode", "description"?, "price"?, "tag"?, "website"?}
Contact email and phone come from the user's account (Users table).
Area, region and map position are worked out from the postal code; the street address
itself is only shown to the owner and to customers who book a visit.
Reply 201: {"business", "user"}
"""
from decimal import Decimal

from common import (BUSINESS_TYPES, CATEGORIES, Attr, HttpError, address_fields, amount, businesses, handler,
                    json_body, new_id, now_iso, owner_business, public_user, require_user, text,
                    update_fields, users)


@handler
def lambda_handler(event, context):
    user = require_user(event)
    if user.get("businessId"):
        raise HttpError(409, "You already have a business on The Grove.")
    data = json_body(event)

    category = data.get("category")
    if category not in CATEGORIES:
        raise HttpError(400, "Please choose a category.")
    business_type = data.get("businessType")
    if business_type not in BUSINESS_TYPES:
        raise HttpError(400, "Please choose whether you sell products or offer a service.")
    website = text(data, "website", required=False, max_len=300)
    if website and not website.startswith(("http://", "https://")):
        raise HttpError(400, "Please use an http or https website address.")

    business = {
        "businessId": new_id(),
        "ownerUserId": user["userId"],
        "ownerName": user.get("name", ""),
        "name": text(data, "name", max_len=80),
        "description": text(data, "description", required=False, max_len=1000),
        "email": user.get("email", ""),
        "phone": user.get("phone", ""),
        "category": category,
        "businessType": business_type,
        "tag": text(data, "tag", required=False, max_len=80) or "New on The Grove",
        "website": website,
        "accent": "#2d6650",
        "rating": "New",
        "reviews": Decimal("0"),
        "createdAt": now_iso(),
        **address_fields(data),
    }
    price = amount(data, "price", required=False)
    if price is not None:
        business["price"] = price

    businesses().put_item(Item=business, ConditionExpression=Attr("businessId").not_exists())
    updated_user = update_fields(
        users(), {"userId": user["userId"]},
        {"isBusiness": True, "businessId": business["businessId"]},
        condition=Attr("businessId").not_exists(),
    )
    return 201, {"business": owner_business(business), "user": public_user(updated_user)}
