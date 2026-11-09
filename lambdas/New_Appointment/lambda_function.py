"""POST /appointments  ->  request a booking (a visit, or an order to collect).

Customer booking:  {"businessId", "service", "date", "time", "type"?: "visit"|"pickup",
                    "customerName"?, "message"?, "lines"?}
    lines (23 Oct) = the products they ticked, [{"name", "quantity"}], checked against the business's own
    list and saved with prices and an `estimate` (the total). `service` then defaults to "2 × Cookies, 1 × Tea".
    When the visit is logged, the site ticks the same products to start with.
    -> status Pending, waiting for the business to confirm. Must be inside opening hours.
    Refused while the business has no products or services listed (27 Oct), or when the customer already has
    a booking (any business) in the same slot (28 Oct).
    The type follows the business (23 Oct): a service business gets an appointment ("visit"), a product
    business an order to collect ("pickup"): today only, Confirmed straight away, and it doesn't hold the slot.
Owner adding one:  {"customerName", "service", "date", "time", "type"?, "customerUserId"?, "message"?}
    (no businessId -> your business; a request WITH a businessId is always a customer booking, 23 Oct)
    -> with customerUserId (one of your past customers): Pending, waiting for the customer.
    -> with only a name (a walk-in without an account): Confirmed straight away.
An appointment takes one 30-minute slot; Pending and Confirmed appointments both hold it.
Reply 201: {"appointment"}
The business's address is copied onto the booking so the customer can find it.
"""
from boto3.dynamodb.conditions import Attr

from common import (BOOKING_TYPES, HttpError, clash_message, customer_clash, Key, appointments, booking_message, business_type, businesses,
                    check_slot, handler, json_body, new_id, now_iso, order_lines, query_all, require_user, text,
                    transactions, today)


def _is_past_customer(user_id, business_id):
    """Only people who have visited or booked this business can be attached by the owner."""
    for table in (transactions(), appointments()):
        if query_all(table, IndexName="userId-date-index",
                     KeyConditionExpression=Key("customerUserId").eq(user_id),
                     FilterExpression=Attr("businessId").eq(business_id)):
            return True
    return False


@handler
def lambda_handler(event, context):
    user = require_user(event)
    data = json_body(event)
    business_id = data.get("businessId") or user.get("businessId")
    if not business_id:
        raise HttpError(400, "Please choose a business to book.")
    business = businesses().get_item(Key={"businessId": business_id}).get("Item")
    if not business:
        raise HttpError(404, "We couldn't find that business.")
    # The owner adds a booking from their own calendar without a businessId. With a businessId it comes from a
    # storefront, so it's a customer booking even when the owner books their own business (e.g. to test it).
    by_owner = business.get("ownerUserId") == user["userId"] and not data.get("businessId")

    # Nothing on the menu yet (27 Oct): customers can't order or book until the owner adds a product or service
    if not by_owner and not (business.get("products") or business.get("items")):
        what = "products" if business_type(business) == "product" else "services"
        raise HttpError(400, f"{business.get('name') or 'This business'} hasn't added any {what} yet, so it isn't taking "
                             f"{'orders' if what == 'products' else 'bookings'} yet.")

    appt_date = text(data, "date", max_len=10)
    appt_time = text(data, "time", max_len=5)
    # A customer's booking follows the business type (23 Oct): a product business takes orders to collect
    # ("pickup", which don't hold the slot), a service business takes appointments ("visit").
    booking_type = data.get("type") or "visit"
    if not by_owner:
        booking_type = "pickup" if business_type(business) == "product" else "visit"
    if booking_type not in BOOKING_TYPES:
        raise HttpError(400, "type must be visit or pickup.")
    if not by_owner and booking_type == "pickup" and appt_date != today():
        raise HttpError(400, "Orders are for collecting today. Please pick a time later today.")
    # Owners may add bookings outside their own opening hours; customers may not.
    check_slot(business, appt_date, appt_time, check_hours=not by_owner, exclusive=booking_type != "pickup")
    if not by_owner:   # 28 Oct: not two bookings at the same time, at any business
        clash = customer_clash(user["userId"], appt_date, appt_time)
        if clash:
            raise HttpError(409, clash_message(clash))
    lines, estimate = order_lines(business, data["lines"]) if data.get("lines") is not None else ([], None)
    if lines and not data.get("service"):
        data["service"] = ", ".join(f"{l['quantity']} × {l['name']}" for l in lines)[:120]
    service = text(data, "service", max_len=120)
    message = text(data, "message", required=False, max_len=500)

    appointment = {
        "appointmentId": new_id(),
        "businessId": business_id,
        "businessName": business.get("name", ""),
        "service": service,
        "type": booking_type,
        "date": appt_date,
        "time": appt_time,
        "createdAt": now_iso(),
    }
    if by_owner:
        appointment["customerName"] = text(data, "customerName", max_len=80)
        customer_id = data.get("customerUserId")
        if customer_id:
            if not isinstance(customer_id, str) or not _is_past_customer(customer_id, business_id):
                raise HttpError(400, "You can only send bookings to your own customers.")
            appointment.update(customerUserId=customer_id, status="Pending", awaiting="customer")
        else:
            appointment["status"] = "Confirmed"
        sender = ("owner", business.get("name", ""))
    else:
        # An order to collect (23 Oct) needs no confirmation: it's placed straight away and the owner sees it as
        # a new order (seenOwnerAt is unset) on Overview. An appointment waits for the owner to confirm.
        pickup = booking_type == "pickup"
        appointment.update(customerUserId=user["userId"], status="Confirmed" if pickup else "Pending",
                           awaiting="" if pickup else "owner",
                           customerName=text(data, "customerName", required=False, max_len=80,
                                             default=user.get("name", "")))
        sender = ("customer", appointment["customerName"])
    if lines:
        appointment["lines"], appointment["estimate"] = lines, estimate
    appointment["messages"] = [booking_message(*sender, "request", message,
                                               {k: appointment[k] for k in ("type", "service", "date", "time")})]
    appointment["lastActivityAt"] = appointment["createdAt"]
    appointment["seen" + sender[0].capitalize() + "At"] = appointment["createdAt"]
    if business.get("address"):
        appointment["businessAddress"] = f"{business['address']}, Singapore {business.get('postalCode', '')}".strip()
    appointments().put_item(Item=appointment)
    return 201, {"appointment": appointment}
