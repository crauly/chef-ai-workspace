"""Opt-in loopback acceptance backend; only a fresh owner in the dedicated Chef DB.

Run with existing server configuration in the process environment. Stop with
POST http://127.0.0.1:8102/test/stop to allow verified cleanup, not a hard kill.
No production/demo owner's existing recipes are used or modified.
"""
import os
import secrets
import sys
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
if os.environ.get('CHEF_LIVE_VOICE') != '1':
    raise RuntimeError('Explicit CHEF_LIVE_VOICE=1 opt-in required')
if os.environ.get('SUPABASE_URL', '').rstrip('/') != 'https://dfvryaybdelgjxihdmth.supabase.co':
    raise RuntimeError('Dedicated Chef project required')

import uvicorn
from supabase import create_client
from chef_ai_workspace.api import app
from chef_ai_workspace.supabase_adapter import SupabasePersistence
from chef_ai_workspace.meta_responses import MetaResponsesProvider

client = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])
provider = MetaResponsesProvider(os.environ['MODEL_API_KEY'])
TABLES = ['recipes', 'recipe_versions', 'mutation_receipts', 'ingredients', 'ingredient_images', 'correction_preferences']
# Establish cleanup compatibility before creating anything in the database.
for table in TABLES:
    client.table(table).select('owner_id').limit(1).execute()
owner = None
try:
    user = client.auth.admin.create_user({'email': f'voice-acceptance-{uuid4()}@example.invalid',
        'password': secrets.token_urlsafe(40), 'email_confirm': True}).user
    if not user:
        raise RuntimeError('Isolated test owner creation failed')
    owner = str(user.id)
    print('Temporary acceptance owner (for cleanup recovery): ' + owner, flush=True)
    app.state.demo_owner_id = owner
    app.state.demo_access_token = 'isolated-live-voice-test-token-48-characters'
    app.state.repository_factory = lambda: SupabasePersistence(client)
    app.state.ai_provider = provider
    server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=8102,
        log_level='error', access_log=False))

    @app.get('/test/live-state')
    def live_state():
        def rows(table, columns):
            return client.table(table).select(columns).eq('owner_id', owner).execute().data or []
        return {'recipes': rows('recipes', 'id,title,revision,state'),
                'versions': rows('recipe_versions', 'id,cost_snapshot'),
                'receipts': rows('mutation_receipts', 'owner_id')}

    @app.post('/test/stop')
    def stop_test_server():
        server.should_exit = True
        return {'stopping': True}

    server.run()
finally:
    if owner:
        client.auth.admin.delete_user(owner)
        counts = {table: len(client.table(table).select('owner_id').eq('owner_id', owner).execute().data or []) for table in TABLES}
        print('Cleanup: ' + str(counts), flush=True)
        if any(counts.values()):
            raise RuntimeError('Test owner cleanup incomplete')
