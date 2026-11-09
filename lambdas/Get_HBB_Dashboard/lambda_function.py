"""GET /business/dashboard  ->  everything the business studio needs in one call.

Reply 200: {
  "business":     {...},
  "transactions": [...],   every ledger entry for this business (visits, orders, manual)
  "appointments": [...],
  "customers":    [...],   derived from transactions + appointments (visits, spent, first/last/next)
  "insights":     {...}    (27 Oct) the Insights page, from the logged visits of the last ?insightDays=30|90|180|365
                           days (default 180; 0 = all time). Ages are grouped with common.age_group:
      customers, visits, repeatCustomers, spent,
      genders / ages / regions: [[label, customers]]   ("Not shared" for people who skipped the question),
      products: [[name, quantity]],
      cameFrom / wentTo: [{businessId, name, category, customers}]   the business right before / after this one
          in the same customers' chains (same chainSessionId), so owners can see who they share customers with.
}
"""
from collections import Counter
from datetime import date, timedelta
from decimal import Decimal

from common import (AGE_GROUPS, GENDERS, HttpError, Key, age_group, appointments, businesses, ddb, handler, owner_business,
                    query_all, require_business_owner, today, transactions, users)

TXN_FIELDS = ["transactionId", "date", "createdAt", "type", "kind", "description", "amount",
              "status", "cashback", "cashbackUsed", "customerName", "customerUserId", "product", "quantity"]
APPT_FIELDS = ["appointmentId", "businessId", "businessName", "customerName", "customerUserId",
               "service", "type", "date", "time", "status", "awaiting", "messages", "lastActivityAt",
               "seenOwnerAt", "seenCustomerAt", "reminder", "createdAt", "amountSpent", "lines", "estimate"]


INSIGHT_DAYS = 180       # default timeframe; the page can ask for 30, 90, 180, 365 or 0 (all time)
INSIGHT_CHOICES = (30, 90, 180, 365, 0)
MAX_CHAIN_LOOKUPS = 300   # one query per customer chain; keeps a busy business's dashboard quick


def _batch_get(table, key, ids, fields):
    """Batch-read some fields of many rows (100 keys per request). fields are names, read via placeholders."""
    found, ids = {}, [i for i in ids if i]
    names = {f"#f{n}": f for n, f in enumerate([key] + fields)}
    for start in range(0, len(ids), 100):
        request = {table.name: {"Keys": [{key: i} for i in ids[start:start + 100]],
                                "ProjectionExpression": ", ".join(names), "ExpressionAttributeNames": names}}
        while request:
            page = ddb().batch_get_item(RequestItems=request)
            for item in page.get("Responses", {}).get(table.name, []):
                found[item[key]] = item
            request = page.get("UnprocessedKeys") or None
    return found


def _contacts(user_ids):
    """Email/phone for registered customers."""
    return _batch_get(users(), "userId", list(user_ids), ["email", "phone"])


def _counted(counter, order=None):
    rows = counter.most_common()
    if order:
        rows.sort(key=lambda r: order.index(r[0]) if r[0] in order else len(order))
    return [[label, n] for label, n in rows]


def _insights(business_id, txns, days=INSIGHT_DAYS):
    since = (date.fromisoformat(today()) - timedelta(days=days)).isoformat() if days else ""
    visits = [t for t in txns if t.get("type") == "Income" and t.get("kind") in ("visit", "order")
              and t.get("date", "") >= since]
    per_person = Counter(t.get("customerUserId") or "name:" + (t.get("customerName") or "") for t in visits)

    # Who they are: what customers chose to share after signing up (Update_User), one count per person
    people = [u for u in per_person if not u.startswith("name:")]
    profiles = _batch_get(users(), "userId", people, ["gender", "age", "ageGroup", "region"])
    def shared(field):
        return Counter(profiles.get(u, {}).get(field) or "Not shared" for u in people)
    ages = Counter(age_group(profiles.get(u, {})) or "Not shared" for u in people)

    products = Counter()
    for t in visits:
        for line in t.get("lines") or []:
            products[line.get("name", "")] += int(line.get("quantity", 1))
        if not t.get("lines") and t.get("product"):
            products[t["product"]] += int(t.get("quantity", 1) or 1)

    # Chain neighbours: in each chain this business was part of, the business just before and just after it
    came, went, seen = Counter(), Counter(), set()
    for t in sorted(visits, key=lambda t: t.get("date", ""), reverse=True):
        user, chain = t.get("customerUserId"), t.get("chainSessionId")
        if not user or not chain or (user, chain) in seen or len(seen) >= MAX_CHAIN_LOOKUPS:
            continue
        seen.add((user, chain))
        stops = [x for x in query_all(transactions(), IndexName="userId-date-index",
                                      KeyConditionExpression=Key("customerUserId").eq(user) & Key("date").eq(t["date"]))
                 if x.get("chainSessionId") == chain and x.get("kind") == "visit"]
        order = []
        for x in sorted(stops, key=lambda x: x.get("createdAt", "")):
            if x["businessId"] not in order:
                order.append(x["businessId"])
        if business_id not in order:
            continue
        at = order.index(business_id)
        if at > 0:
            came[order[at - 1]] += 1
        if at + 1 < len(order):
            went[order[at + 1]] += 1
    names = _batch_get(businesses(), "businessId", list(set(came) | set(went)), ["name", "category"])
    def neighbours(counter):
        # A business that has since been deleted is left out: there's no one to get in touch with
        return [{"businessId": b, "name": names[b].get("name", ""), "category": names[b].get("category", ""),
                 "customers": n} for b, n in counter.most_common() if b in names][:8]

    return {
        "days": days,
        "customers": len(per_person),
        "visits": len(visits),
        "repeatCustomers": sum(1 for n in per_person.values() if n > 1),
        "spent": sum((Decimal(str(t.get("amount", 0))) for t in visits), Decimal("0")),
        "genders": _counted(Counter(g if g in GENDERS else "Not shared" for g in
                                    (profiles.get(u, {}).get("gender") for u in people)), GENDERS + ["Not shared"]),
        "ages": _counted(ages, AGE_GROUPS + ["Not shared"]),
        "regions": _counted(shared("region")),
        "products": [[n, q] for n, q in products.most_common(6) if n],
        "cameFrom": neighbours(came),
        "wentTo": neighbours(went),
    }


def _customers(txns, appts):
    people = {}

    def person(user_id, name):
        key = user_id or ("name:" + (name or "").strip().lower())
        if key not in people:
            people[key] = {"userId": user_id, "name": name or "Customer", "visits": 0, "spent": Decimal("0"),
                           "first": None, "last": None, "next": None}
        return people[key]

    for t in txns:
        if t.get("type") != "Income" or t.get("kind") not in ("visit", "order"):
            continue
        if not (t.get("customerUserId") or t.get("customerName")):
            continue
        p = person(t.get("customerUserId"), t.get("customerName"))
        p["visits"] += 1
        p["spent"] += Decimal(str(t.get("amount", 0)))
        p["first"] = min(filter(None, [p["first"], t["date"]]))
        p["last"] = max(filter(None, [p["last"], t["date"]]))

    now = today()
    for a in appts:
        if a.get("status") != "Confirmed" or a.get("date", "") < now:
            continue
        p = person(a.get("customerUserId"), a.get("customerName"))
        p["next"] = min(filter(None, [p["next"], a["date"]]))

    contacts = _contacts({p["userId"] for p in people.values() if p["userId"]})
    for p in people.values():
        c = contacts.get(p["userId"], {})
        p["email"], p["phone"] = c.get("email", ""), c.get("phone", "")
    return sorted(people.values(), key=lambda p: p["last"] or p["next"] or "", reverse=True)


def _insight_days(event):
    try:
        days = int((event.get("queryStringParameters") or {}).get("insightDays", INSIGHT_DAYS))
    except (TypeError, ValueError):
        return INSIGHT_DAYS
    return days if days in INSIGHT_CHOICES else INSIGHT_DAYS


@handler
def lambda_handler(event, context):
    _, business_id = require_business_owner(event)
    business = businesses().get_item(Key={"businessId": business_id}).get("Item")
    if not business:
        raise HttpError(404, "We couldn't find your business.")

    # Transactions GSI "businessId-date-index": partition businessId, sort date
    txns = query_all(transactions(), IndexName="businessId-date-index",
                     KeyConditionExpression=Key("businessId").eq(business_id))
    # Appointments GSI "businessId-date-index": partition businessId, sort date
    appts = query_all(appointments(), IndexName="businessId-date-index",
                      KeyConditionExpression=Key("businessId").eq(business_id))

    return 200, {
        "business": owner_business(business),
        "transactions": [{k: t.get(k) for k in TXN_FIELDS if k in t} for t in txns],
        "appointments": [{k: a.get(k) for k in APPT_FIELDS if k in a} for a in appts],
        "customers": _customers(txns, appts),
        "insights": _insights(business_id, txns, _insight_days(event)),
    }
