import asyncio, json, sys, os
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "api-server"))
from quaver_server.session import session, self_euin

async def main():
    euin = self_euin()
    um = session.client.user
    raw = await um._build_cgi(
        module="music.UnifiedHomepage.UnifiedHomepageSrv",
        method="GetHomepageHeader",
        param={"uin": euin, "IsQueryTabDetail": 1},
        disable_parse=True,
    )
    d = raw.get("data", raw)
    info = d.get("Info") or {}
    base = info.get("BaseInfo") or {}
    print("BaseInfo keys:", list(base.keys()))
    hits = {k: v for k, v in base.items() if any(t in k.lower() for t in
            ("type","ident","singer","music","vip","green","flag","intro","level","auth","cert","tag","icon","gender","login"))}
    print("身份字段:", json.dumps(hits, ensure_ascii=False))
    raw2 = await um._build_cgi(module="VipLogin.VipLoginInter", method="vip_login_base",
                               param={}, disable_parse=True, require_login=True)
    v = raw2.get("data", raw2)
    scalars = {k: v[k] for k in v if not isinstance(v[k], (dict, list))}
    print("VIP 标量字段:", json.dumps(scalars, ensure_ascii=False)[:500])
    ident = v.get("identity") or v.get("Identity") or {}
    ihits = {k: val for k, val in ident.items() if isinstance(val, (int, str, bool))}
    print("identity:", json.dumps(ihits, ensure_ascii=False)[:500])

asyncio.run(main())
