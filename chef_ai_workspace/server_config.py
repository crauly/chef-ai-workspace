"""Server-only runtime wiring for Supabase Auth and protected persistence.

SUPABASE_SERVICE_ROLE_KEY must never be shipped to browsers or committed.
JWT identity is retrieved from Supabase Auth, never decoded without verification.
"""
import os

from .api import app
from .supabase_adapter import SupabasePersistence


def configure_supabase(app_instance=app):
    from supabase import create_client

    url = os.environ["SUPABASE_URL"]
    service_role = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    if not url.startswith("https://") or not service_role:
        raise RuntimeError("Valid Supabase service URL and key required")
    client = create_client(url, service_role)

    def verify_token(access_token: str) -> str:
        result = client.auth.get_user(access_token)
        user = getattr(result, "user", None)
        if user is None or not getattr(user, "id", None):
            raise ValueError("Unverified user")
        return str(user.id)

    app_instance.state.verify_token = verify_token
    app_instance.state.repository_factory = lambda: SupabasePersistence(client)
    return app_instance
