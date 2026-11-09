"""Optional API Gateway (HTTP API) Lambda authorizer.

Attach it to every route except /auth/* and GET /businesses*.
  Payload format version: 2.0     Simple responses: ON
  Identity source: $request.header.Authorization     Caching: 300 s

Each function also checks the Bearer token itself (common.require_user_id), so the API is
protected even without this authorizer. Using it rejects bad tokens before your
functions run, which saves invocations.
"""
from common import verify_token


def lambda_handler(event, context):
    header = (event.get("headers") or {}).get("authorization", "")
    claims = verify_token(header[7:].strip()) if header.startswith("Bearer ") else None
    if not claims:
        return {"isAuthorized": False}
    return {"isAuthorized": True, "context": {"userId": claims["sub"], "email": claims.get("email", "")}}
