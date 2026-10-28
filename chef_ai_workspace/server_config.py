"""Server-only runtime wiring for Supabase Auth and protected persistence.

SUPABASE_SERVICE_ROLE_KEY must never be shipped to browsers or committed.
JWT identity is retrieved from Supabase Auth, never decoded without verification.
"""
import os
from urllib.parse import urlsplit

from .api import app
from .supabase_adapter import SupabasePersistence


def configure_ai(app_instance):
    """Choose the native Meta adapter when MODEL_API_KEY is set. Never fall back on error."""
    meta_key = os.environ.get("MODEL_API_KEY")
    if meta_key:
        from .meta_responses import MetaResponsesProvider
        app_instance.state.ai_provider = MetaResponsesProvider(api_key=meta_key)
    elif os.environ.get("AI_API_KEY"):
        from .ai_provider import ChatCompletionsProvider
        app_instance.state.ai_provider = ChatCompletionsProvider(
            endpoint=os.environ.get("AI_CHAT_COMPLETIONS_URL", "https://api.openai.com/v1/chat/completions"),
            api_key=os.environ["AI_API_KEY"], model=os.environ.get("AI_MODEL", "gpt-4o-mini"))
    elif hasattr(app_instance.state, "ai_provider"):
        delattr(app_instance.state, "ai_provider")
    return app_instance


def configure_supabase(app_instance=app):
    from supabase import create_client

    url = os.environ["SUPABASE_URL"]
    service_role = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    parsed = urlsplit(url)
    # This backend carries a privileged key: reject every project except the
    # dedicated Chef AI sandbox before instantiating a database client.
    if (parsed.scheme != "https" or parsed.hostname != "dfvryaybdelgjxihdmth.supabase.co"
            or parsed.port is not None or parsed.username is not None
            or parsed.password is not None or parsed.path not in ("", "/")
            or parsed.query or parsed.fragment or not service_role):
        raise RuntimeError("Dedicated Chef AI Supabase configuration required")
    client = create_client(url, service_role)

    def verify_token(access_token: str) -> str:
        result = client.auth.get_user(access_token)
        user = getattr(result, "user", None)
        if user is None or not getattr(user, "id", None):
            raise ValueError("Unverified user")
        return str(user.id)

    app_instance.state.verify_token = verify_token
    app_instance.state.repository_factory = lambda: SupabasePersistence(client)
    demo_owner = os.environ.get("DEMO_OWNER_ID")
    demo_token = os.environ.get("DEMO_ACCESS_TOKEN")
    if demo_owner or demo_token:
        from uuid import UUID
        if not demo_owner or not demo_token or len(demo_token) < 24:
            raise RuntimeError("Demo owner and strong access token required together")
        UUID(demo_owner)
        app_instance.state.demo_owner_id = demo_owner
        app_instance.state.demo_access_token = demo_token
    from .correction_hints import SupabaseCorrectionHints
    app_instance.state.correction_hints = SupabaseCorrectionHints(client)
    return configure_ai(app_instance)
