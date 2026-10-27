"""Live Supabase Auth transport checks (no secret credentials required).

An actual user JWT is tested only when a dedicated test account is configured
through GitHub Actions secrets. Never echo passwords, tokens or key material.
"""
import json
import os
import urllib.error
import urllib.request
import unittest

URL = "https://dfvryaybdelgjxihdmth.supabase.co"
KEY = os.environ.get("SUPABASE_PUBLISHABLE_KEY", "")
EMAIL = os.environ.get("AUTH_TEST_EMAIL", "")
PASSWORD = os.environ.get("AUTH_TEST_PASSWORD", "")

def call(path, token=None, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    headers={"apikey":KEY, "Content-Type":"application/json"}
    if token is not None:
        headers["Authorization"]="Bearer "+token
    req=urllib.request.Request(URL+path,data=data,headers=headers,
                               method="POST" if data is not None else "GET")
    try:
        with urllib.request.urlopen(req,timeout=18) as res:
            return res.status,json.load(res)
    except urllib.error.HTTPError as err:
        return err.code,json.load(err)

class LiveSupabaseAuth(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not KEY:
            raise RuntimeError("SUPABASE_PUBLISHABLE_KEY missing")

    def test_invalid_bearer_denied(self):
        status,_=call("/auth/v1/user",token="not-a-jwt")
        self.assertIn(status,(401,403))

    def test_password_login_with_real_jwt_when_credentials_available(self):
        if not EMAIL or not PASSWORD:
            self.skipTest("Dedicated AUTH_TEST_EMAIL and AUTH_TEST_PASSWORD secrets not configured")
        status,result=call("/auth/v1/token?grant_type=password",
                           payload={"email":EMAIL,"password":PASSWORD})
        self.assertEqual(status,200,"Dedicated test user login rejected")
        access=result.get("access_token")
        self.assertTrue(access,"Login did not issue JWT")
        status,user=call("/auth/v1/user",token=access)
        self.assertEqual(status,200,"Supabase rejected JWT issued by its own Auth endpoint")
        self.assertTrue(user.get("id"),"Verified user ID missing")
        self.assertEqual(user.get("email"),EMAIL)

if __name__=="__main__":
    unittest.main()
