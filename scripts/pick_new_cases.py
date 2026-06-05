import json, random, re

with open(r'D:\Desktop\cc_workspace\weixin-aibot\data\runtime\proactive-eval\cst-history.json', 'r', encoding='utf-8') as f:
    history = json.load(f)

# Turns used in Round 1 (from the original report - 45 cases)
r1_turns = {1,2,3,4,5,6,7,10,12,13,14,15,16,19,20,21,22,25,26,28,31,33,34,37,40,41,42,43,44,45,46,47,48,49,51,54,55,64,82,84,85,87,88,109,110}

# Read Round 2 results to get the full list of used turns
with open(r'D:\Desktop\cc_workspace\weixin-aibot\data\runtime\rag-pilot-eval\chisato-rag-pilot-results.json', 'r', encoding='utf-8') as f:
    r2 = json.load(f)

r2_turns = set()
for r in r2['results']:
    r2_turns.add(r['turn_index'])

all_used = r1_turns | r2_turns
print(f'Round 1 turns: {len(r1_turns)}')
print(f'Round 2 turns: {len(r2_turns)}')
print(f'Union used: {len(all_used)}')
print(f'Total history: {len(history)}')

# Find completely unused turns
unused = []
for i, t in enumerate(history):
    turn_idx = i + 1
    if turn_idx not in all_used:
        msg = t.get('user', '')
        unused.append({
            'turn': turn_idx,
            'msg': msg[:250].replace('\n', ' / '),
            'msg_full': msg,
            'ts': t.get('timestamp_local', ''),
            'id': t.get('id', ''),
            'idx': i,
            'assistant': t.get('assistant', '')[:200]
        })

print(f'Completely unused: {len(unused)}')

# Filter out very short/casual messages
def is_substantial(msg):
    text = msg.strip()
    if len(text) < 15:
        return False
    # Skip pure greetings
    if re.match(r'^(早上好|晚上好|晚安|早安|午安|你好|在吗|嗯|哦|哈哈|hh|拜拜)[\s!！。.,，~～]*$', text):
        return False
    return True

substantial = [u for u in unused if is_substantial(u['msg_full'])]
print(f'Substantial unused: {len(substantial)}')

# Randomly select 15 with good diversity
random.seed(42)
selected = random.sample(substantial, min(15, len(substantial)))
selected.sort(key=lambda x: x['turn'])

print('\n=== Selected 15 new cases ===')
for s in selected:
    print(f"Turn {s['turn']} [{s['ts']}]: {s['msg'][:180]}")
    print()

# Save for the test script
out = [{'turn_index': s['turn'], 'user': s['msg_full'], 'time': s['ts'], 'id': s['id'], 'idx': s['idx']} for s in selected]
with open(r'D:\Desktop\cc_workspace\weixin-aibot\data\runtime\rag-pilot-eval\new15_cases.json', 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print('Saved to new15_cases.json')
