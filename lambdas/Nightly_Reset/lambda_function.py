"""Nightly_Reset  ->  clear Chain_Sessions every night at 23:59 (Singapore time).

Run by an EventBridge Scheduler schedule, not by the API: cron(59 23 * * ? *), time zone Asia/Singapore.
You can also run it by hand from the Lambda console (Test, any event).

Deletes every row in Chain_Sessions, so everyone's next visit starts a fresh chain.
Nothing else is touched:
  - visits stay in Transactions (History still shows them),
  - cash back balances stay in Users,
  - a user's activeChainSessionId may now point at a missing row; New_Transaction,
    Get_Customer_Data and Get_Recommendations already treat that as "no chain yet".

Reply: {"deleted": <rows deleted>, "at": "<when it ran>"} (also written to CloudWatch Logs).
"""
import logging

from common import chains, now_iso

log = logging.getLogger()
log.setLevel(logging.INFO)


def lambda_handler(event, context):
    table = chains()
    deleted, kwargs = 0, {"ProjectionExpression": "sessionId"}
    with table.batch_writer() as batch:   # sends the deletes 25 at a time
        while True:
            page = table.scan(**kwargs)
            for row in page.get("Items", []):
                batch.delete_item(Key={"sessionId": row["sessionId"]})
                deleted += 1
            if "LastEvaluatedKey" not in page:
                break
            kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]
    result = {"deleted": deleted, "at": now_iso()}
    log.info("Chain_Sessions cleared: %s", result)
    return result
