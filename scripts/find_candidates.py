import json, re, sys
sys.stdout.reconfigure(encoding='utf-8')

with open(r'D:\Desktop\cc_workspace\weixin-aibot\data\runtime\proactive-eval\cst-history.json', 'r', encoding='utf-8') as f:
    history = json.load(f)

used_turns = {1,2,3,4,5,6,7,10,12,13,14,15,16,19,20,21,22,25,26,28,31,33,34,37,40,41,42,43,44,45,46,47,48,49,51,54,55,64,82,84,85,87,88,109,110}

high_risk = re.compile(r'睡眠|睡着|失眠|电费|花音|合租|小彩|隔壁班|同居|PasPale|假唱|退团|梦想|说话|语气|心理独白|长篇|Leo|红茶|路痴|电车|薰|日菜|麻弥|伊芙')

available = []
for i, t in enumerate(history):
    turn_idx = i + 1
    if turn_idx not in used_turns:
        is_high = bool(high_risk.search(t.get('user', '')))
        available.append({
            'turn': turn_idx,
            'high_risk': is_high,
            'msg': t.get('user', '')[:300],
            'ts': t.get('timestamp_local', '')
        })

high_available = [a for a in available if a['high_risk']]
low_available = [a for a in available if not a['high_risk']]

out = {
    'total': len(history),
    'available_total': len(available),
    'available_high': len(high_available),
    'available_low': len(low_available),
    'high_candidates': high_available[:80],
    'low_candidates': low_available[:40]
}

with open(r'D:\Desktop\cc_workspace\weixin-aibot\data\runtime\rag-pilot-eval\candidates.json', 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)

print(f"Wrote {len(high_available)} high-risk, {len(low_available)} low-risk candidates")
