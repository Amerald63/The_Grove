"""PATCH /appointments/{appointmentId}  ->  move a booking along its conversation.

Body: {"action": ..., ...}
  "confirm"                     accept the latest version (only the side being waited on)
  "propose"  {"service"? or "lines"? (29 Oct, [{"name", "quantity"}] from the menu), "date"?, "time"?,
              "type"?, "message"?}
                                suggest a change; the other side then has to confirm it.
                                Walk-in bookings (no customer account) just change.
  "decline"  {"message"?}       turn down a Pending booking you are being asked to confirm
  "cancel"   {"message"?}       cancel a Pending or Confirmed booking (either side)
  "message"  {"message"}        send a message without changing anything
  "read"                        mark the conversation as read
Older clients may still send {"status": "Cancelled"|"Confirmed"} or {"reminder": bool}.
Allowed for the business owner, or the customer who made the booking.
A booking is Confirmed only once both sides have agreed to the same version.
Reply 200: {"appointment"}
"""
from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError

from common import (BOOKING_TYPES, HttpError, clash_message, customer_clash, appointments, boolean, booking_message, businesses,
                    check_slot, handler, json_body, now_iso, order_lines, path_param, require_user, text,
                    update_fields)

MAX_MESSAGES = 200
OPEN = ("Pending", "Confirmed")


@handler
def lambda_handler(event, context):
    user = require_user(event)
    appointment_id = path_param(event, "appointmentId")
    appt = appointments().get_item(Key={"appointmentId": appointment_id}).get("Item")
    is_owner = bool(appt and user.get("businessId") and appt.get("businessId") == user.get("businessId"))
    is_customer = bool(appt and appt.get("customerUserId") == user["userId"])
    if not (is_owner or is_customer):
        raise HttpError(404, "We couldn't find that appointment.")
    role = "owner" if is_owner else "customer"
    other = "customer" if is_owner else "owner"
    name = appt.get("businessName", "") if is_owner else appt.get("customerName", "")

    data = json_body(event)
    action = data.get("action")
    if not action:  # older clients
        if data.get("status") == "Cancelled":
            action = "cancel"
        elif data.get("status") == "Confirmed":
            action = "confirm"
        elif "reminder" in data:
            item = update_fields(appointments(), {"appointmentId": appointment_id},
                                 {"reminder": boolean(data, "reminder")})
            return 200, {"appointment": item}
        else:
            raise HttpError(400, "Nothing to update.")

    now = now_iso()
    seen = "seen" + role.capitalize() + "At"
    if action == "read":
        item = update_fields(appointments(), {"appointmentId": appointment_id}, {seen: now})
        return 200, {"appointment": item}

    status = appt.get("status")
    message = text(data, "message", required=False, max_len=500)
    changes = {}

    if action == "message":
        if not message:
            raise HttpError(400, "Please write a message.")
        entry = booking_message(role, name, "message", message)

    elif action == "confirm":
        if status != "Pending" or appt.get("awaiting") != role:
            raise HttpError(409, "There's nothing waiting for you to confirm on this booking.")
        if role == "customer":   # 28 Oct: not two bookings at the same time
            clash = customer_clash(user["userId"], appt["date"], appt["time"], exclude_id=appointment_id)
            if clash:
                raise HttpError(409, clash_message(clash))
        changes.update(status="Confirmed", awaiting="")
        entry = booking_message(role, name, "confirm", message)

    elif action == "decline":
        if status != "Pending" or appt.get("awaiting") != role:
            raise HttpError(409, "There's nothing waiting for you to decline on this booking.")
        changes.update(status="Declined", awaiting="")
        entry = booking_message(role, name, "decline", message)

    elif action == "cancel":
        if status not in OPEN:
            raise HttpError(409, "This booking is already closed.")
        changes.update(status="Cancelled", awaiting="")
        entry = booking_message(role, name, "cancel", message)

    elif action == "propose":
        if status not in OPEN:
            raise HttpError(409, "This booking is closed, so it can't be changed.")
        change = {}
        if data.get("lines") is not None:
            # 29 Oct: the order picked from the business's menu, e.g. [{"name": "Cookies", "quantity": 2}]
            menu = businesses().get_item(Key={"businessId": appt["businessId"]}).get("Item") or {}
            lines, estimate = order_lines(menu, data["lines"])
            old_lines = [(l.get("name"), int(l.get("quantity", 0))) for l in appt.get("lines") or []]
            if [(l["name"], l["quantity"]) for l in lines] != old_lines:
                change["service"] = ", ".join(f"{l['quantity']} × {l['name']}" for l in lines)[:120]
                changes.update(lines=lines, estimate=estimate)
        elif "service" in data:
            service = text(data, "service", max_len=120)
            if service != appt.get("service"):
                change["service"] = service
        if "type" in data:
            if data["type"] not in BOOKING_TYPES:
                raise HttpError(400, "type must be visit or pickup.")
            if data["type"] != appt.get("type", "visit"):
                change["type"] = data["type"]
        new_date = text(data, "date", required=False, max_len=10, default=appt["date"])
        new_time = text(data, "time", required=False, max_len=5, default=appt["time"])
        if (new_date, new_time) != (appt["date"], appt["time"]):
            business = businesses().get_item(Key={"businessId": appt["businessId"]}).get("Item") or {}
            business.setdefault("businessId", appt["businessId"])
            # The owner may move a booking outside opening hours; a customer may not.
            check_slot(business, new_date, new_time, exclude_id=appointment_id, check_hours=not is_owner,
                       exclusive=change.get("type", appt.get("type", "visit")) != "pickup")
            if appt.get("customerUserId"):   # 28 Oct: the customer can't be in two places at once
                clash = customer_clash(appt["customerUserId"], new_date, new_time, exclude_id=appointment_id)
                if clash:
                    raise HttpError(409, clash_message(clash) if is_customer else
                                    "Your customer already has another booking at that time. Please pick another time.")
            change.update(date=new_date, time=new_time)
        if not change:
            raise HttpError(400, "Change the service, date or time first.")
        changes.update(change)
        if appt.get("customerUserId"):
            changes.update(status="Pending", awaiting=other)  # the other side must agree again
        entry = booking_message(role, name, "change", message, change)

    else:
        raise HttpError(400, "Unknown action.")

    messages = list(appt.get("messages") or [])
    messages.append(entry)
    changes.update(messages=messages[-MAX_MESSAGES:], lastActivityAt=now, **{seen: now})
    try:
        # Only apply if nobody else changed the booking since we read it.
        cond = (Attr("lastActivityAt").eq(appt["lastActivityAt"]) if appt.get("lastActivityAt")
                else Attr("lastActivityAt").not_exists())
        item = update_fields(appointments(), {"appointmentId": appointment_id}, changes, condition=cond)
    except ClientError as err:
        if err.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise HttpError(409, "This booking was just updated. Please reload and try again.")
        raise
    return 200, {"appointment": item}
