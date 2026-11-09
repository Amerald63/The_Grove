"""PATCH /me  ->  update the logged-in user's profile and preferences.

Body: any of {"name", "phone", "region", "interests": [...], "reminders", "recommendations",
              "itemRatings": {"matcha_latte": 5, ...}, "travel": "near"|"anywhere",
              "gender", "age"}   (27 Oct: optional, for business Insights. gender from common.GENDERS;
              age a whole number 5–120, or null to clear it. Older accounts may have "ageGroup" instead.)
"itemRatings" (1-5 per item) and "travel" feed the recommender (Get_Recommendations).
"itemRatings" replaces the saved ratings; items left out fall back to the customer's interests.
"review" (27 Oct): {"businessId", "rating": 1-5, "text"?} adds or replaces your one review of a business
    (not your own). It's saved on the business as reviewList[userId], and its rating / reviews count are
    worked out again. Reply 200: {"user", "business"}.
Reply 200: {"user"}
(Email is the login identifier and is not changed here.)
"""
from decimal import Decimal

from common import (AGE_GROUPS, CATEGORIES, GENDERS, MAX_REVIEW_TEXT, REGIONS, TRAVEL_MODES, HttpError, boolean,
                    businesses, handler, item_ratings, json_body, now_iso, public_business, public_user,
                    require_user_id, review_key, text, update_fields, users)


def _review(user_id, data):
    """Add or replace this customer's review of a business; returns the updated business."""
    if not isinstance(data, dict) or not isinstance(data.get("businessId"), str):
        raise HttpError(400, "Please choose a business to review.")
    try:
        rating = int(data.get("rating"))
    except (TypeError, ValueError):
        rating = 0
    if not 1 <= rating <= 5:
        raise HttpError(400, "Please give 1 to 5 stars.")
    words = text(data, "text", required=False, max_len=MAX_REVIEW_TEXT)
    business = businesses().get_item(Key={"businessId": data["businessId"]}).get("Item")
    if not business:
        raise HttpError(404, "We couldn't find that business.")
    if business.get("ownerUserId") == user_id:
        raise HttpError(400, "You can't review your own business.")
    user = users().get_item(Key={"userId": user_id}).get("Item") or {}
    parts = (user.get("name") or "A customer").split()
    name = parts[0] + (f" {parts[-1][0]}." if len(parts) > 1 else "")
    reviews = dict(business.get("reviewList") or {})
    reviews[user_id] = {"by": review_key(user_id), "name": name, "rating": rating, "text": words,
                        "at": now_iso(), **({"edited": True} if user_id in reviews else {})}
    average = Decimal(sum(int(r["rating"]) for r in reviews.values())) / len(reviews)
    item = update_fields(businesses(), {"businessId": business["businessId"]},
                         {"reviewList": reviews, "rating": average.quantize(Decimal("0.1")), "reviews": len(reviews)})
    return public_business(item)


@handler
def lambda_handler(event, context):
    user_id = require_user_id(event)
    data = json_body(event)
    changes = {}
    if "name" in data:
        changes["name"] = text(data, "name", max_len=60)
    if "phone" in data:
        changes["phone"] = text(data, "phone", required=False, max_len=30)
    if "region" in data:
        if data["region"] not in REGIONS:
            raise HttpError(400, "Please choose a region.")
        changes["region"] = data["region"]
    if "interests" in data:
        if not isinstance(data["interests"], list):
            raise HttpError(400, "interests must be a list.")
        changes["interests"] = [c for c in data["interests"] if c in CATEGORIES]
    if "itemRatings" in data:
        changes["itemRatings"] = item_ratings(data["itemRatings"])
    if "travel" in data:
        if data["travel"] not in TRAVEL_MODES:
            raise HttpError(400, "Please choose how far you'll travel.")
        changes["travel"] = data["travel"]
    if "age" in data:
        age = data["age"]
        if age in (None, ""):
            changes["age"] = None
        else:
            try:
                age = int(str(age).strip())
            except ValueError:
                raise HttpError(400, "Please enter your age as a number.")
            if not 5 <= age <= 120:
                raise HttpError(400, "Please enter an age between 5 and 120.")
            changes["age"] = age
    for key, allowed in (("gender", GENDERS), ("ageGroup", AGE_GROUPS)):
        if key in data:
            if data[key] not in allowed:
                raise HttpError(400, "Please choose one of the options.")
            changes[key] = data[key]
    for flag in ("reminders", "recommendations"):
        if flag in data:
            changes[flag] = boolean(data, flag)
    if "review" in data:
        business = _review(user_id, data["review"])
        user = update_fields(users(), {"userId": user_id}, changes) if changes else users().get_item(Key={"userId": user_id})["Item"]
        return 200, {"user": public_user(user), "business": business}
    if not changes:
        raise HttpError(400, "Nothing to update.")
    item = update_fields(users(), {"userId": user_id}, changes)
    return 200, {"user": public_user(item)}
