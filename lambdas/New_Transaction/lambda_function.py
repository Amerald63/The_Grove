"""Two routes share this function.

POST /visits                  (customer)  log a visit and earn chain cash back
    Body:  {"businessId", "amount"?, "appointmentId"?, "useCashback"?, "item"?, "product"?, "lines"?}
           amount         = what the customer spent (defaults to the business's price, or 0)
           appointmentId  = the booking this visit was for; it is marked Completed
           useCashback    = true: apply the whole wallet balance (up to the amount spent)
           item           = what they bought, a key from common.ITEMS (feeds the recommender).
                            Once recommendations have been shown, the visit also records
                            recommendationRank: where the item was in them (1 = top pick,
                            0 = not recommended). tools/live_hit_rate.py turns that into Hit@K.
           product        = the business's own product name they picked (22 Oct), shown in History.
                            The site sends its best-matched type as `item`, so the model still learns.
           lines          = (23 Oct) the products they ticked: [{"name", "quantity"}]. The amount is then
                            worked out here from the business's own prices (any "amount" sent is ignored),
                            the lines are saved on the visit with their prices, `product` becomes
                            "2 × Cookies, 1 × Tea" and `item` the type of the line that cost the most.
           Service businesses (23 Oct, common.business_type) need an appointmentId; a confirmed booking
           can be logged on any day (29 Oct). A visit from a booking with an order uses that
           order as booked (28 Oct); lines in the request are ignored. Product businesses can log a visit any time.
    Reply 201: {"transaction", "chain", "cashback", "cashbackUsed", "cashbackBalance", "repeat"}
    The owner (29 Oct) can log a booking at their own business: {"businessId", "appointmentId", "amount"?}.
           The order as booked sets the amount (else "amount", else the booking's estimate). A customer
           with an account gets the visit in their chain and its cash back (their wallet isn't spent);
           a walk-in is saved as a visit with no chain. The visit has loggedBy "owner".

POST /business/transactions   (owner)     add an entry to the business ledger
    Body:  {"description", "date", "type": "Income"|"Expense", "amount",
            "status": "Paid"|"Pending", "kind"?: "manual"|"order",
            "customerName"?, "product"?, "quantity"?}
    Reply 201: {"transaction"}

Chain rule: the first visit in a chain earns nothing; every visit after that to a
*new* business earns CASHBACK_AMOUNT. There is no limit on chain length.
Going back to a business (already in the chain, or visited before in an older chain) is still
logged, any number of times, with no cash back.
"""
from datetime import datetime
from decimal import Decimal

from boto3.dynamodb.conditions import Attr, Key
from botocore.exceptions import ClientError

from common import (DATE_RE, HttpError, _tz, amount, chain_is_current, appointments, business_type, businesses, cashback_amount, chains,
                    handler, item_key, json_body, main_item, new_id, now_iso, order_lines, path, public_chain, query_all,
                    require_business_owner, require_user, text, today, transactions,
                    update_fields, users)


def _active_chain(user):
    session_id = user.get("activeChainSessionId")
    if not session_id:
        return None
    session = chains().get_item(Key={"sessionId": session_id}).get("Item")
    return session if chain_is_current(session) else None   # yesterday's chain is over: start a new one


def _start_chain(user):
    session = {"sessionId": new_id(), "userId": user["userId"], "businessIds": [],
               "status": "active", "totalCashback": Decimal("0"), "startedAt": now_iso()}
    chains().put_item(Item=session)
    update_fields(users(), {"userId": user["userId"]}, {"activeChainSessionId": session["sessionId"]})
    return session


def _conditional_failed(err):
    return err.response["Error"]["Code"] == "ConditionalCheckFailedException"


def record_visit(event):
    user = require_user(event)
    data = json_body(event)
    business_id = text(data, "businessId", max_len=64)
    business = businesses().get_item(Key={"businessId": business_id}).get("Item")
    if not business:
        raise HttpError(404, "We couldn't find that business.")
    if business.get("ownerUserId") == user["userId"]:
        if data.get("appointmentId"):   # 29 Oct: the owner logs a booking's visit from their calendar
            return _owner_log(business, data)
        raise HttpError(400, "Visits to your own business don't count towards your chain.")
    item = item_key(data, "item") if data.get("item") else ""
    product = text(data, "product", required=False, max_len=60)
    lines = []
    if data.get("lines") is not None:
        lines, spent = order_lines(business, data["lines"])
        item = main_item(lines)
        product = ", ".join(f"{l['quantity']} × {l['name']}" for l in lines)[:300]
    else:
        spent = amount(data, "amount", required=False)
        if spent is None:
            spent = business.get("price", Decimal("0"))

    # A visit logged from a booking. The booking is only marked Completed after the visit
    # is saved, and each booking has one fixed transaction id, so a retry can't double-log.
    appointment_id = str(data.get("appointmentId") or "")
    txn_id = new_id()
    if appointment_id:
        appt = appointments().get_item(Key={"appointmentId": appointment_id}).get("Item")
        if not appt or appt.get("customerUserId") != user["userId"] or appt.get("businessId") != business_id:
            raise HttpError(404, "We couldn't find that booking.")
        if appt.get("status") in ("Cancelled", "Declined"):
            raise HttpError(400, "This booking was cancelled.")
        if appt.get("status") == "Pending":
            raise HttpError(400, "This booking hasn't been confirmed yet.")
        # 29 Oct: a confirmed booking can be logged on any day (logging is how the site is tested)
        # 28 Oct: the order is what was booked; the customer can't change it when logging the visit
        if appt.get("lines"):
            lines, spent, item, product = _booked_order(appt)
        txn_id = "visit-" + appointment_id
        if transactions().get_item(Key={"transactionId": txn_id}).get("Item"):
            raise HttpError(409, "You've already logged this visit.")

    elif business_type(business) == "service":
        raise HttpError(400, f"{business.get('name', 'This business')} works by appointment. Book one first, then log your visit after it.")

    session = _active_chain(user) or _start_chain(user)
    # Going back to a business is fine: it's logged, with no cash back. "Back" = it's in the chain,
    # or the customer logged a visit there before (an older chain, or before chains were tracked).
    in_chain = business_id in session.get("businessIds", [])
    repeat = in_chain or _visited_before(user, business_id)

    # Spend wallet cash back on this purchase: the whole balance, capped at the amount spent.
    used = Decimal("0")
    if data.get("useCashback") is True:
        used = min(Decimal(str(user.get("cashbackBalance", 0))), spent).quantize(Decimal("0.01"))
        if used > 0:
            try:
                users().update_item(
                    Key={"userId": user["userId"]},
                    UpdateExpression="ADD #c :minus",
                    ConditionExpression=Attr("cashbackBalance").gte(used),
                    ExpressionAttributeNames={"#c": "cashbackBalance"},
                    ExpressionAttributeValues={":minus": -used},
                )
            except ClientError as err:
                if _conditional_failed(err):
                    raise HttpError(409, "Your wallet balance changed. Please try again.")
                raise
    try:
        return _save_visit(user, business_id, spent, used, appointment_id, txn_id, session, repeat, in_chain, item, product, lines)
    except Exception:
        if used > 0:  # give the cash back again if the visit wasn't saved
            users().update_item(Key={"userId": user["userId"]}, UpdateExpression="ADD #c :back",
                                ExpressionAttributeNames={"#c": "cashbackBalance"},
                                ExpressionAttributeValues={":back": used})
        raise


def _visited_before(user, business_id):
    return bool(query_all(transactions(), IndexName="userId-date-index",
                          KeyConditionExpression=Key("customerUserId").eq(user["userId"]),
                          FilterExpression=Attr("businessId").eq(business_id) & Attr("kind").eq("visit")))


def _recommendation_rank(user, item):
    """1-based position of `item` in the customer's last recommendations, 0 if it wasn't there."""
    shown = (user.get("lastRecommendations") or {}).get("items") or []
    return shown.index(item) + 1 if item in shown else 0


def _booked_order(appt):
    """The order as booked: (lines, total, item, product); lines is [] when the booking has no order."""
    lines = [{"name": l["name"], "quantity": int(l["quantity"]), "price": Decimal(str(l["price"])),
              "item": l.get("item", "")} for l in appt.get("lines") or []]
    total = sum((l["price"] * l["quantity"] for l in lines), Decimal("0")).quantize(Decimal("0.01"))
    return lines, total, main_item(lines), ", ".join(f"{l['quantity']} × {l['name']}" for l in lines)[:300]


def _owner_log(business, data):
    business_id = business["businessId"]
    appointment_id = str(data.get("appointmentId") or "")
    appt = appointments().get_item(Key={"appointmentId": appointment_id}).get("Item")
    if not appt or appt.get("businessId") != business_id:
        raise HttpError(404, "We couldn't find that booking.")
    if appt.get("status") in ("Cancelled", "Declined"):
        raise HttpError(400, "This booking was cancelled.")
    if appt.get("status") == "Pending":
        raise HttpError(400, "This booking hasn't been confirmed yet.")
    txn_id = "visit-" + appointment_id
    if appt.get("status") == "Completed" or transactions().get_item(Key={"transactionId": txn_id}).get("Item"):
        raise HttpError(409, "This visit has already been logged.")
    lines, spent, item, product = _booked_order(appt)
    if not lines:
        spent = amount(data, "amount", required=False)
        if spent is None:
            spent = Decimal(str(appt.get("estimate") or business.get("price") or 0))
        product = appt.get("service", "")[:300]
    customer = users().get_item(Key={"userId": appt["customerUserId"]}).get("Item") if appt.get("customerUserId") else None
    if customer:
        session = _active_chain(customer) or _start_chain(customer)
        in_chain = business_id in session.get("businessIds", [])
        repeat = in_chain or _visited_before(customer, business_id)
        return _save_visit(customer, business_id, spent, Decimal("0"), appointment_id, txn_id, session, repeat, in_chain,
                           item, product, lines, logged_by="owner")
    # A walk-in (no account): a visit for the owner's books, with no chain or cash back
    name = appt.get("customerName") or "Walk-in"
    txn = {"transactionId": txn_id, "businessId": business_id, "customerName": name, "kind": "visit",
           "type": "Income", "status": "Paid", "amount": spent, "cashback": Decimal("0"), "cashbackUsed": Decimal("0"),
           "description": f"Visit · {name}", "date": today(), "createdAt": now_iso(),
           "appointmentId": appointment_id, "loggedBy": "owner"}
    if product:
        txn["product"] = product
    if lines:
        txn["lines"] = lines
    if item:
        txn["item"] = item
    try:
        transactions().put_item(Item=txn, ConditionExpression=Attr("transactionId").not_exists())
    except ClientError as err:
        if _conditional_failed(err):
            raise HttpError(409, "This visit has already been logged.")
        raise
    update_fields(appointments(), {"appointmentId": appointment_id},
                  {"status": "Completed", "amountSpent": spent, "loggedAt": now_iso()})
    return 201, {"transaction": txn}


def _save_visit(user, business_id, spent, used, appointment_id, txn_id, session, repeat, in_chain, item="", product="", lines=(),
                logged_by=""):
    reward = Decimal("0") if repeat else (cashback_amount() if session.get("businessIds") else Decimal("0"))

    # 1. Save the visit first, so it always shows in History even if a later step fails.
    txn = {
        "transactionId": txn_id,
        "businessId": business_id,
        "customerUserId": user["userId"],
        "customerName": user.get("name", ""),
        "chainSessionId": session["sessionId"],
        "kind": "visit",
        "type": "Income",
        "status": "Paid",
        "amount": spent,
        "cashback": reward,
        "cashbackUsed": used,
        "description": f"Visit · {user.get('name', 'Customer')}",
        "date": today(),
        "createdAt": now_iso(),
    }
    if appointment_id:
        txn["appointmentId"] = appointment_id
    if logged_by:
        txn["loggedBy"] = logged_by
    if product:
        txn["product"] = product
    if lines:
        txn["lines"] = list(lines)
    if item:
        txn["item"] = item
        if user.get("lastRecommendations"):   # only once recommendations have been shown
            txn["recommendationRank"] = _recommendation_rank(user, item)
    try:
        transactions().put_item(Item=txn, ConditionExpression=Attr("transactionId").not_exists())
    except ClientError as err:
        if _conditional_failed(err):
            raise HttpError(409, "You've already logged this visit.")
        raise

    # 2. Not in the chain yet: add it (only once, even if two visits arrive together). A business
    #    visited in an older chain joins this one too, but earns nothing (reward is 0 for a repeat).
    if not in_chain:
        try:
            session = chains().update_item(
                Key={"sessionId": session["sessionId"]},
                UpdateExpression="SET #b = list_append(#b, :new) ADD #t :reward",
                ConditionExpression=Attr("status").eq("active") & ~Attr("businessIds").contains(business_id),
                ExpressionAttributeNames={"#b": "businessIds", "#t": "totalCashback"},
                ExpressionAttributeValues={":new": [business_id], ":reward": reward},
                ReturnValues="ALL_NEW",
            )["Attributes"]
        except ClientError as err:
            if not _conditional_failed(err):
                raise
            repeat, reward = True, Decimal("0")
            update_fields(transactions(), {"transactionId": txn_id}, {"cashback": reward})
            txn["cashback"] = reward

    # 3. Close the booking and credit the cash back.
    if appointment_id:
        update_fields(appointments(), {"appointmentId": appointment_id},
                      {"status": "Completed", "amountSpent": spent, "loggedAt": now_iso()})
    balance = users().update_item(
        Key={"userId": user["userId"]},
        UpdateExpression="ADD #c :reward",
        ExpressionAttributeNames={"#c": "cashbackBalance"},
        ExpressionAttributeValues={":reward": reward},
        ReturnValues="UPDATED_NEW",
    )["Attributes"]["cashbackBalance"]
    return 201, {"transaction": txn, "chain": public_chain(session), "cashback": reward,
                 "cashbackUsed": used, "cashbackBalance": balance, "repeat": repeat}


def add_ledger_entry(event):
    _, business_id = require_business_owner(event)
    data = json_body(event)
    entry_type = data.get("type")
    if entry_type not in ("Income", "Expense"):
        raise HttpError(400, "type must be Income or Expense.")
    status = data.get("status", "Paid")
    if status not in ("Paid", "Pending"):
        raise HttpError(400, "status must be Paid or Pending.")
    kind = data.get("kind", "manual")
    if kind not in ("manual", "order"):
        raise HttpError(400, "kind must be manual or order.")
    entry_date = text(data, "date", required=False, max_len=10) or today()
    if not DATE_RE.match(entry_date):
        raise HttpError(400, "date must look like 2026-10-09.")

    txn = {
        "transactionId": new_id(),
        "businessId": business_id,
        "kind": kind,
        "type": entry_type,
        "status": status,
        "amount": amount(data, "amount", minimum=Decimal("0.01")),
        "description": text(data, "description", max_len=200),
        "date": entry_date,
        "createdAt": now_iso(),
    }
    customer = text(data, "customerName", required=False, max_len=80)
    if customer:
        txn["customerName"] = customer
    if kind == "order":
        txn["product"] = text(data, "product", max_len=120)
        quantity = data.get("quantity")
        if not isinstance(quantity, int) or not 1 <= quantity <= 1000:
            raise HttpError(400, "quantity must be a whole number from 1 to 1000.")
        txn["quantity"] = quantity
    transactions().put_item(Item=txn)
    return 201, {"transaction": txn}


@handler
def lambda_handler(event, context):
    if path(event).rstrip("/").endswith("/visits"):
        return record_visit(event)
    return add_ledger_entry(event)
