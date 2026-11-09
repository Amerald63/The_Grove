"""Public business directory.

GET /businesses                         ->  {"businesses": [...]}   (every listing)
GET /businesses/{businessId}            ->  {"business": {...}}
GET /businesses/{businessId}/schedule   ->  {"hours", "hoursMode", "dates", "businessType", "taken": [{"date", "time", "status"}]}
    Opening hours plus every slot from today on that is held by a Pending or Confirmed
    booking. No names or services, so any customer can see when a business is busy.
"""
from common import (HOLDING, HttpError, Key, appointments, business_type, businesses, handler, path,
                    public_business, query_all, scan_all, today)


@handler
def lambda_handler(event, context):
    business_id = (event.get("pathParameters") or {}).get("businessId")
    if business_id:
        item = businesses().get_item(Key={"businessId": business_id}).get("Item")
        if not item:
            raise HttpError(404, "We couldn't find that business.")
        if path(event).rstrip("/").endswith("/schedule"):
            rows = query_all(appointments(), IndexName="businessId-date-index",
                             KeyConditionExpression=Key("businessId").eq(business_id) & Key("date").gte(today()))
            taken = sorted(({"date": r["date"], "time": r["time"], "status": r["status"], "type": r.get("type", "visit")}
                            for r in rows if r.get("status") in HOLDING),
                           key=lambda r: (r["date"], r["time"]))
            # Order pickups don't hold a slot: several customers can collect in the same half hour
            taken = [r for r in taken if r.get("type", "visit") != "pickup"]
            return 200, {"hours": item.get("hours") or {}, "hoursMode": item.get("hoursMode") or "regular",
                         "dates": item.get("dates") or {}, "businessType": business_type(item), "taken": taken}
        return 200, {"business": public_business(item)}
    # A scan is fine for a directory of a few hundred listings. If it grows into the
    # thousands, add a GSI on region and page through it instead.
    items = scan_all(businesses())
    return 200, {"businesses": [public_business(i) for i in items]}
