"""Local-only browser fixture backed by migrated disposable PostgreSQL."""
import os
from contextlib import asynccontextmanager
from uuid import uuid4
from fastapi import FastAPI
from test_ingredient_edit_postgres import IngredientEditPostgresTests
from test_procurement_postgres import sql, literal
from chef_ai_workspace.api import app as chef_app

assert os.environ.get('CHEF_TEST_PGPORT'), 'Requires explicit disposable local PostgreSQL'
fixture=IngredientEditPostgresTests()

@asynccontextmanager
async def lifespan(app):
    fixture.setUp()
    chef_app.state.demo_access_token='test-only-backend-token'
    fixture.headers={'X-Demo-Access':'test-only-backend-token'}
    try:
        fixture.other=fixture.save(fixture.body('Rakuten','600'))
        yield
    finally:
        sql('drop trigger if exists ingredient_browser_failure on public.price_observations;drop function if exists public.ingredient_browser_failure();')
        fixture.tearDown()

app=FastAPI(lifespan=lifespan)
@app.get('/test/state')
def state():
    return {'ingredient':fixture.ingredient,'supplier':fixture.supplier,'row':fixture.row(),
            'observations':fixture.count('price_observations'),
            'recipes':[fixture.recipe['id'],fixture.other['id']]}
@app.post('/test/fault/{enabled}')
def fault(enabled:int):
    sql('drop trigger if exists ingredient_browser_failure on public.price_observations;drop function if exists public.ingredient_browser_failure();')
    if enabled:
        sql(f"""create function public.ingredient_browser_failure() returns trigger language plpgsql as $$
        begin if new.owner_id={literal(fixture.owner)} then raise exception 'private browser test failure'; end if;return new;end $$;
        create trigger ingredient_browser_failure before insert on public.price_observations for each row execute function public.ingredient_browser_failure();""")
    return {'ok':True}
app.mount('/',chef_app)
