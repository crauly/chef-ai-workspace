"""Production process entrypoint for the isolated Chef AI demo.

Importing this module fails startup when required environment configuration
or the dedicated Supabase host guard is invalid. Never use for in-memory tests.
"""
from .api import app
from .server_config import configure_supabase

configure_supabase(app)
