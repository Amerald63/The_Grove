"""POST /auth/login  ->  check email + password and return a session token.

Body: {"email", "password"}
Reply 200: {"token", "user"}
"""
from common import (HttpError, Key, check_password, handler, json_body, make_token, public_user,
                    query_all, users)

WRONG = "That email and password don't match. Please try again."


@handler
def lambda_handler(event, context):
    data = json_body(event)
    email = str(data.get("email") or "").strip().lower()
    password = data.get("password")
    if not email or not isinstance(password, str) or not password:
        raise HttpError(400, "Please enter your email and password.")

    matches = query_all(users(), IndexName="email-index", KeyConditionExpression=Key("email").eq(email))
    if not matches:
        raise HttpError(401, WRONG)
    # The GSI may not project passwordHash, so read the full item by its key.
    user = users().get_item(Key={"userId": matches[0]["userId"]}).get("Item")
    if not user or not check_password(password, user.get("passwordHash", "")):
        raise HttpError(401, WRONG)
    return 200, {"token": make_token(user["userId"], user["email"]), "user": public_user(user)}
