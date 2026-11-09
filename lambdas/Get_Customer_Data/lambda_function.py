"""GET /me  ->  the logged-in customer's profile, visit history, active chain and bookings.

Reply 200: {"user", "visits": [...], "chain": {...}|null, "appointments": [...]}
Each appointment has visitLogged: true once a visit has been saved for it.
"""
from common import (Key, appointments, chains, handler, public_chain, public_user, query_all,
                    require_user, transactions)


@handler
def lambda_handler(event, context):
    user = require_user(event)

    # Transactions GSI "userId-date-index": partition customerUserId, sort date
    rows = query_all(transactions(), IndexName="userId-date-index",
                     KeyConditionExpression=Key("customerUserId").eq(user["userId"]),
                     ScanIndexForward=False)
    visits = [{"transactionId": t["transactionId"], "businessId": t["businessId"], "date": t["date"],
               "amount": t.get("amount", 0), "cashback": t.get("cashback", 0),
               "cashbackUsed": t.get("cashbackUsed", 0), "item": t.get("item", ""), "product": t.get("product", ""), "lines": t.get("lines", []),
               "createdAt": t.get("createdAt", "")}
              for t in rows if t.get("kind") == "visit"]
    visits.sort(key=lambda v: v["createdAt"], reverse=True)

    chain = None
    if user.get("activeChainSessionId"):
        chain = public_chain(chains().get_item(Key={"sessionId": user["activeChainSessionId"]}).get("Item"))

    # Appointments GSI "userId-date-index": partition customerUserId, sort date
    bookings = query_all(appointments(), IndexName="userId-date-index",
                         KeyConditionExpression=Key("customerUserId").eq(user["userId"]))
    # visitLogged: a visit has been saved for this booking
    logged = {t.get("appointmentId") for t in rows if t.get("kind") == "visit" and t.get("appointmentId")}
    for b in bookings:
        b["visitLogged"] = b["appointmentId"] in logged

    return 200, {"user": public_user(user), "visits": visits, "chain": chain, "appointments": bookings}
