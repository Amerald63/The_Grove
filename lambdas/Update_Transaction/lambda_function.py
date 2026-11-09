"""PATCH /business/transactions/{transactionId}  ->  e.g. mark a pending payment as paid.

Body: {"status": "Paid"|"Pending"}
Reply 200: {"transaction"}
"""
from common import (HttpError, handler, json_body, path_param, require_business_owner,
                    transactions, update_fields)


@handler
def lambda_handler(event, context):
    _, business_id = require_business_owner(event)
    transaction_id = path_param(event, "transactionId")
    txn = transactions().get_item(Key={"transactionId": transaction_id}).get("Item")
    if not txn or txn.get("businessId") != business_id:
        raise HttpError(404, "We couldn't find that transaction.")
    if txn.get("kind") == "visit":
        raise HttpError(400, "Chain visits are recorded automatically and can't be edited.")

    status = json_body(event).get("status")
    if status not in ("Paid", "Pending"):
        raise HttpError(400, "status must be Paid or Pending.")
    item = update_fields(transactions(), {"transactionId": transaction_id}, {"status": status})
    return 200, {"transaction": item}
