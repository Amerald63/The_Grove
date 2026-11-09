"""POST /auth/signup  ->  create a customer account and return a session token.

Body: {"name", "email", "password", "interests": [...], "region"?}
Reply 201: {"token", "user"}
"""
from decimal import Decimal

from common import (CATEGORIES, EMAIL_RE, REGIONS, HttpError, Key, handler, hash_password,
                    json_body, make_token, new_id, now_iso, public_user, query_all, text, users)


@handler
def lambda_handler(event, context):
    data = json_body(event)
    name = text(data, "name", max_len=60)
    email = text(data, "email", max_len=254).lower()
    if not EMAIL_RE.match(email):
        raise HttpError(400, "Please enter a valid email address.")
    password = data.get("password")
    if not isinstance(password, str) or len(password) < 8:
        raise HttpError(400, "Please use at least 8 characters for your password.")
    if len(password) > 200:
        raise HttpError(400, "That password is too long.")
    interests = data.get("interests") or []
    if not isinstance(interests, list) or not interests:
        raise HttpError(400, "Choose at least one interest to personalise your discoveries.")
    interests = [c for c in interests if c in CATEGORIES]
    if not interests:
        raise HttpError(400, "Choose at least one interest from the list.")
    region = data.get("region") if data.get("region") in REGIONS else "Central"

    # Users has a GSI "email-index" (partition key: email) so we can look people up by email.
    if query_all(users(), IndexName="email-index", KeyConditionExpression=Key("email").eq(email)):
        raise HttpError(409, "This email already has an account. Please log in.")

    user = {
        "userId": new_id(),
        "email": email,
        "name": name,
        "passwordHash": hash_password(password),
        "phone": "",
        "region": region,
        "interests": interests,
        "reminders": True,
        "recommendations": True,
        "isBusiness": False,
        "cashbackBalance": Decimal("0"),
        "createdAt": now_iso(),
    }
    users().put_item(Item=user)
    return 201, {"token": make_token(user["userId"], email), "user": public_user(user)}
