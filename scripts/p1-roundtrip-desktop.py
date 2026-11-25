"""Desktop side of the isolated Android round-trip test. cwd is the pinned Git archive."""
import asyncio
import base64
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import sys

backend = Path.cwd() / "backend"
sys.path[:0] = [str(backend / "scripts"), str(backend), str(Path.cwd())]
import exchange_trip_handoff as handoff
from app.services.exchange_outbox import list_outbound_operations


async def edit(database, revision, entity, branch):
    conn = await handoff.create_connection(database)
    try:
        store = handoff.SessionStore(conn)
        settings = handoff.Settings(_env_file=None, amap_api_key=None)
        app = handoff.FastAPI()
        app.state.store = store
        app.dependency_overrides[handoff.get_settings] = lambda: settings
        handoff.register_exception_handlers(app)
        app.include_router(handoff.routes_session.router)
        app.include_router(handoff.routes_itinerary.router)
        async with handoff.open_checkpointer(database) as checkpointer:
            app.state.graph = handoff.build_graph(
                handoff._OfflineNoopLLM(), handoff._OfflineNoopSearch(), settings=settings, checkpointer=checkpointer
            )
            async with handoff.AsyncClient(transport=handoff.ASGITransport(app=app), base_url="http://handoff.local") as client:
                detail = await client.get(f"/api/versions/{revision}")
                detail.raise_for_status()
                original = detail.json()
                item = next(e for e in original["itinerary"]["expenses"] if e["id"] == entity)
                assert item["amount_cents"] == 1723
                payload = {k: item[k] for k in ("title", "category", "notes", "day", "activity_id",
                                                  "receipt_ids", "budget_item_id", "settles_budget")}
                route = f"/api/versions/{revision}/expenses/{entity}"
                noop = await client.put(route, json={**payload, "amount": "17.23"})
                noop.raise_for_status()
                assert noop.json()["version"]["id"] == revision
                assert noop.json()["itinerary"]["expenses"] == original["itinerary"]["expenses"]
                assert await list_outbound_operations(store, branch_id=branch) == []
                changed = await client.put(route, json={**payload, "amount": "21.50"})
                changed.raise_for_status()
                return changed.json()["version"]["id"]
    finally:
        await conn.close()


def queue(database):
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute("SELECT operation_id, entity_id, branch_id, expected_revision_id, source_revision_id, "
                            "intent_sha256, delivery_state, CAST(raw_command_json AS BLOB) AS raw "
                            "FROM exchange_outbound_operations").fetchall()
        assert len(rows) == 1
        row = dict(rows[0])
        row["bytes_base64"] = base64.b64encode(row.pop("raw")).decode("ascii")
        return row


if __name__ == "__main__":
    db = handoff._validate_handoff_database(Path(sys.argv[2]))
    if sys.argv[1] == "edit":
        result = asyncio.run(edit(db, *sys.argv[3:]))
    elif sys.argv[1] == "queue":
        result = queue(db)
    else:
        raise ValueError("Unknown action")
    print(json.dumps(result))
