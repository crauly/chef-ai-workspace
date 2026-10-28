"""Deployment guard must fail closed before making a privileged Supabase client."""
import os
import unittest
from unittest.mock import patch

from chef_ai_workspace.server_config import configure_supabase
from chef_ai_workspace.api import app


class DedicatedProjectGuardTests(unittest.TestCase):
    def test_wrong_hosts_are_rejected_before_client_creation(self):
        urls = [
            "https://jfaxjgvqfsacprenodkg.supabase.co",
            "https://dfvryaybdelgjxihdmth.supabase.co.evil.example",
            "http://dfvryaybdelgjxihdmth.supabase.co",
            "https://dfvryaybdelgjxihdmth.supabase.co@evil.example",
            "https://dfvryaybdelgjxihdmth.supabase.co/path",
            "https://dfvryaybdelgjxihdmth.supabase.co?unsafe=1",
        ]
        for url in urls:
            with self.subTest(url=url):
                with patch.dict(os.environ, {
                    "SUPABASE_URL": url, "SUPABASE_SERVICE_ROLE_KEY": "not-a-real-key",
                }), patch("supabase.create_client") as client:
                    with self.assertRaises(RuntimeError):
                        configure_supabase(app)
                    client.assert_not_called()

    def test_dedicated_host_reaches_client_factory(self):
        with patch.dict(os.environ, {
            "SUPABASE_URL": "https://dfvryaybdelgjxihdmth.supabase.co",
            "SUPABASE_SERVICE_ROLE_KEY": "not-a-real-key",
        }), patch("supabase.create_client", side_effect=RuntimeError("factory reached")) as client:
            with self.assertRaisesRegex(RuntimeError, "factory reached"):
                configure_supabase(app)
            client.assert_called_once()


if __name__ == "__main__":
    unittest.main()
