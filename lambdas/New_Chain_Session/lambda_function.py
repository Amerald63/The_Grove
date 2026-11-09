"""POST /chain/new  ->  close the current chain so the next visit starts a fresh one.

Reply 200: {"chain": null, "closedSessionId": "..."|null}
The next POST /visits creates the new Chain_Sessions item automatically.
"""
from common import chains, handler, now_iso, require_user, update_fields, users


@handler
def lambda_handler(event, context):
    user = require_user(event)
    session_id = user.get("activeChainSessionId")
    if session_id:
        session = chains().get_item(Key={"sessionId": session_id}).get("Item")
        if session and session.get("status") == "active":
            update_fields(chains(), {"sessionId": session_id}, {"status": "closed", "closedAt": now_iso()})
        users().update_item(Key={"userId": user["userId"]}, UpdateExpression="REMOVE #a",
                            ExpressionAttributeNames={"#a": "activeChainSessionId"})
    return 200, {"chain": None, "closedSessionId": session_id}
