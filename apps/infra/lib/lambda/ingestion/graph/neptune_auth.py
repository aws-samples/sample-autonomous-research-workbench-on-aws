"""SigV4 IAM authentication for Neptune Bolt connections.

Copied from infon_core.store.neptune_auth on the feat/extraction-quality-tiers
branch. Neptune IAM auth over Bolt uses a JSON bearer token containing
SigV4-signed headers, passed as basic-auth credentials; AuthManagers.basic
re-calls the provider when the server rejects an expired token (~5 min window).
"""

from __future__ import annotations

import json
import logging

import boto3
import neo4j
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from neo4j.auth_management import AuthManagers

log = logging.getLogger(__name__)


def _sign_neptune_token(region: str, endpoint: str, port: int) -> neo4j.Auth:
    session = boto3.Session()
    credentials = session.get_credentials().get_frozen_credentials()

    host_header = f"{endpoint}:{port}"
    request = AWSRequest(
        method="GET",
        url=f"https://{endpoint}:{port}/opencypher",
        headers={"Host": host_header},
    )
    SigV4Auth(credentials, "neptune-db", region).add_auth(request)

    signed_headers = dict(request.headers)
    token_dict: dict[str, str] = {
        "Authorization": signed_headers["Authorization"],
        "HttpMethod": "GET",
        "Host": host_header,
        "X-Amz-Date": signed_headers["X-Amz-Date"],
    }
    if "X-Amz-Security-Token" in signed_headers:
        token_dict["X-Amz-Security-Token"] = signed_headers["X-Amz-Security-Token"]

    return neo4j.basic_auth("username", json.dumps(token_dict))


def build_neptune_auth_manager(
    region: str, endpoint: str, port: int = 8182
) -> neo4j.auth_management.AuthManager:
    def _provider() -> neo4j.Auth:
        log.debug("Signing fresh Neptune IAM token for %s:%d", endpoint, port)
        return _sign_neptune_token(region, endpoint, port)

    return AuthManagers.basic(_provider)
