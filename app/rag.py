# -*- coding: utf-8 -*-
"""BangDream Knowledge RAG using local embeddings and a Qdrant vector store.

build: parse markdown knowledge files, embed chunks, and persist them in Qdrant.
query: embed the user message, search the local vector store, rerank with
metadata, and return context.
"""

import argparse
import fnmatch
import json
import os
import re
import shutil
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams

try:
    from fastembed import TextEmbedding
except ImportError:
    TextEmbedding = None


APP_DIR = Path(__file__).parent
PROJECT_ROOT = APP_DIR.parent
CONFIG_FILE = PROJECT_ROOT / "data" / "config.json"


def load_app_config() -> dict:
    try:
        if CONFIG_FILE.exists():
            return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


APP_CONFIG = load_app_config()


def cfg(key: str, default=None):
    cur = APP_CONFIG
    for part in key.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return default
        cur = cur[part]
    return default if cur is None else cur


def cfg_int(key: str, default: int) -> int:
    try:
        return int(cfg(key, default))
    except Exception:
        return default


def cfg_float(key: str, default: float) -> float:
    try:
        return float(cfg(key, default))
    except Exception:
        return default


def cfg_list(key: str, default=None) -> list[str]:
    raw = cfg(key, default or [])
    if isinstance(raw, list):
        return [str(v).strip().replace("\\", "/").strip("/") for v in raw if str(v).strip()]
    if isinstance(raw, str):
        return [p.strip().replace("\\", "/").strip("/") for p in re.split(r"[,;]", raw) if p.strip()]
    return []


def cfg_path(key: str, default) -> Path:
    raw = os.environ.get(f"WEIXIN_{key.upper().replace('.', '_')}") or cfg(key, str(default))
    p = Path(raw)
    return p if p.is_absolute() else PROJECT_ROOT / p


KB_DIR = cfg_path("rag.knowledgeDir", PROJECT_ROOT / "data" / "knowledge")
STORE_DIR = cfg_path("rag.storeDir", PROJECT_ROOT / "data" / "rag_vector_store")
MODEL_CACHE_DIR = cfg_path("rag.modelCacheDir", PROJECT_ROOT / "data" / ".fastembed_cache")
META_FILE = STORE_DIR / "rag_meta.json"
COLLECTION_NAME = str(cfg("rag.collectionName", "bangdream_knowledge"))

EMBED_MODEL = os.environ.get("WEIXIN_RAG_EMBED_MODEL") or str(cfg("rag.embedModel", "BAAI/bge-small-zh-v1.5"))
TOP_K = cfg_int("rag.topK", 3)
MIN_SCORE = cfg_float("rag.minScore", 0.48)
SCORE_MARGIN = cfg_float("rag.scoreMargin", 0.16)
CHUNK_MIN_CHARS = 80
CHUNK_MAX_CHARS = cfg_int("rag.chunkMaxChars", 1600)
RESULT_MAX_CHARS = cfg_int("rag.resultMaxChars", 1200)
BATCH_SIZE = cfg_int("rag.batchSize", 32)
RERANK_LIMIT = cfg_int("rag.rerankLimit", max(256, TOP_K * 24))
INCLUDE_DIRS = cfg_list("rag.includeDirs")
EXCLUDE_DIRS = cfg_list("rag.excludeDirs")
EXCLUDE_FILES = cfg_list("rag.excludeFiles")

CHARACTER_ALIASES = {
    "白鹭千圣": "白鹭千圣",
    "梦中的千圣": "白鹭千圣",
    "千圣": "白鹭千圣",
    "小千圣": "白鹭千圣",
    "丸山彩": "丸山彩",
    "小彩": "丸山彩",
    "彩": "丸山彩",
    "松原花音": "松原花音",
    "花音": "松原花音",
    "濑田薰": "濑田薰",
    "小薰": "濑田薰",
    "薰": "濑田薰",
    "冰川日菜": "冰川日菜",
    "日菜": "冰川日菜",
    "冰川纱夜": "冰川纱夜",
    "纱夜": "冰川纱夜",
    "大和麻弥": "大和麻弥",
    "麻弥": "大和麻弥",
    "小麻弥": "大和麻弥",
    "若宫伊芙": "若宫伊芙",
    "伊芙": "若宫伊芙",
    "小伊芙": "若宫伊芙",
    "千早爱音": "千早爱音",
    "爱音": "千早爱音",
    "长崎素世": "长崎素世",
    "素世": "长崎素世",
    "市谷有咲": "市谷有咲",
    "有咲": "市谷有咲",
    "户山香澄": "户山香澄",
    "香澄": "户山香澄",
    "花园多惠": "花园多惠",
    "多惠": "花园多惠",
    "小多惠": "花园多惠",
    "山吹沙绫": "山吹沙绫",
    "沙绫": "山吹沙绫",
    "牛込里美": "牛込里美",
    "里美": "牛込里美",
    "奥泽美咲": "奥泽美咲",
    "美咲": "奥泽美咲",
    "北泽育美": "北泽育美",
    "育美": "北泽育美",
    "弦卷心": "弦卷心",
    "心": "弦卷心",
    "凑友希那": "凑友希那",
    "友希那": "凑友希那",
    "今井莉莎": "今井莉莎",
    "莉莎": "今井莉莎",
    "宇田川亚子": "宇田川亚子",
    "亚子": "宇田川亚子",
    "白金燐子": "白金燐子",
    "燐子": "白金燐子",
    "宇田川巴": "宇田川巴",
    "巴": "宇田川巴",
    "美竹兰": "美竹兰",
    "兰": "美竹兰",
    "青叶摩卡": "青叶摩卡",
    "摩卡": "青叶摩卡",
    "上原绯玛丽": "上原绯玛丽",
    "绯玛丽": "上原绯玛丽",
    "羽泽鸫": "羽泽鸫",
    "鸫": "羽泽鸫",
    "桐谷透子": "桐谷透子",
    "透子": "桐谷透子",
    "八潮瑠唯": "八潮瑠唯",
    "瑠唯": "八潮瑠唯",
    "二叶筑紫": "二叶筑紫",
    "筑紫": "二叶筑紫",
    "仓田真白": "仓田真白",
    "真白": "仓田真白",
    "广町七深": "广町七深",
    "七深": "广町七深",
    "高松灯": "高松灯",
    "灯": "高松灯",
    "椎名立希": "椎名立希",
    "立希": "椎名立希",
    "要乐奈": "要乐奈",
    "乐奈": "要乐奈",
    "长崎爽世": "长崎素世",
    "爽世": "长崎素世",
    "丰川祥子": "丰川祥子",
    "祥子": "丰川祥子",
    "若叶睦": "若叶睦",
    "睦": "若叶睦",
    "八幡海铃": "八幡海铃",
    "海铃": "八幡海铃",
    "祐天寺若麦": "祐天寺若麦",
    "若麦": "祐天寺若麦",
    "三角初华": "三角初华",
    "初华": "三角初华",
    "纯田真奈": "纯田真奈",
    "真奈": "纯田真奈",
    "和奏瑞依": "LAYER",
    "LAYER": "LAYER",
    "佐藤益木": "MASKING",
    "MASKING": "MASKING",
    "鳰原令王那": "PAREO",
    "PAREO": "PAREO",
    "朝日六花": "LOCK",
    "LOCK": "LOCK",
    "珠手知由": "CHU2",
    "CHU2": "CHU2",
}

PROFILE_CHARACTERS = {
    "白鹭千圣": "白鹭千圣",
    "梦中的千圣": "白鹭千圣",
    "丸山彩": "丸山彩",
    "千早爱音": "千早爱音",
    "长崎素世": "长崎素世",
}

QUERY_TYPE_PATTERNS = [
    ("lore", r"身高|生日|血型|学校|学部|大学|乐队|成员|经历|过去|以前|曾经|关系|朋友|队友|同伴|互动|称呼|设定|资料|官方|剧情|假唱|退团|作品|歌曲|角色|几岁|多大|多高|哪里|哪儿|花咲川|羽丘|庆鹏|四叶|月之森|CiRCLE|RiNG|PasPale|Pastel.*Palettes|Roselia|Afterglow|PoPiPa|Poppin.*Party|HHW|Hello.*Happy.*World|Morfonica|RAS|Raise.*Suilen|MyGO|Ave.*Mujica|CRYCHIC"),
    ("names", r"长崎素世|千早爱音|丸山彩|白鹭千圣|梦中的千圣|素世|爱音|小彩|伊芙|麻弥|日菜|纱夜|薰|花音|育美|有咲|香澄|多惠|沙绫|里美|美咲|心|灯|友希那|莉莎|亚子|燐子|巴|摩卡|兰|鸫|绯玛丽|透子|筑紫|瑠唯|真白|六花|LOCK|LAYER|MASKING|PAREO|CHU2|乐奈|立希|海铃|若麦|睦|祥子"),
]

CASUAL_PATTERNS = [
    r"^(早上好|早安|早呀|早啊|早|上午好)[哦呀啊啦嘛~～!！。,.，\s]*$",
    r"^(晚上好|晚安|午安|下午好)[哦呀啊啦嘛~～!！。,.，\s]*$",
    r"^(你好|您好|在吗|在不在|hello|hi|hey)[哦呀啊啦嘛~～!！。,.，\s]*$",
    r"^(哈哈+|hhh+|嘿嘿+|嗯+|哦+|啊+)[哦呀啊啦嘛~～!！。,.，\s]*$",
]


def require_embedding():
    if TextEmbedding is None:
        raise RuntimeError(
            "fastembed is not installed. Install it with: "
            "python -m pip install fastembed"
        )
    return TextEmbedding(
        model_name=EMBED_MODEL,
        cache_dir=str(MODEL_CACHE_DIR),
        providers=["CPUExecutionProvider"],
    )


def normalize_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def ensure_list(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        if text.startswith("[") and text.endswith("]"):
            try:
                parsed = json.loads(text)
                if isinstance(parsed, list):
                    return ensure_list(parsed)
            except Exception:
                pass
            text = text[1:-1]
        return [p.strip().strip('"').strip("'") for p in text.split(",") if p.strip()]
    return [str(value).strip()] if str(value).strip() else []


def parse_scalar(value: str):
    value = value.strip()
    if not value:
        return ""
    if value.startswith("[") and value.endswith("]"):
        try:
            return json.loads(value)
        except Exception:
            return ensure_list(value)
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    if value.lower() in {"true", "false"}:
        return value.lower() == "true"
    return value


def parse_frontmatter(text: str) -> tuple[dict, str]:
    if not text.startswith("---"):
        return {}, text
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n?", text, flags=re.S)
    if not match:
        return {}, text
    raw = match.group(1)
    body = text[match.end():]
    meta = {}
    current_key = None
    for line in raw.splitlines():
        m = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if m:
            current_key = m.group(1)
            value = m.group(2).strip()
            meta[current_key] = [] if value == "" else parse_scalar(value)
            continue
        item = re.match(r"^\s*-\s*(.+)$", line)
        if item and current_key:
            if not isinstance(meta.get(current_key), list):
                meta[current_key] = ensure_list(meta.get(current_key))
            meta[current_key].append(parse_scalar(item.group(1)))
    return meta, body


def normalize_metadata(meta: dict) -> dict:
    out = dict(meta or {})
    for key in ("subjects", "characters", "relation_pairs", "categories", "tags"):
        out[key] = ensure_list(out.get(key))
    if out.get("relation_pair") and not out.get("relation_pairs"):
        out["relation_pairs"] = [str(out["relation_pair"])]
    if "category" in out and out["category"] and not out.get("categories"):
        out["categories"] = [str(out["category"])]
    if "type" in out and "doc_type" not in out:
        out["doc_type"] = str(out["type"])
    for key in ("timeline_order", "line_index"):
        if key in out and out[key] not in (None, ""):
            try:
                out[key] = int(out[key])
            except Exception:
                pass
    return out


def should_skip_query(query: str) -> bool:
    q = query.strip().lower()
    if not q:
        return True
    if len(q) <= 24:
        for pattern in CASUAL_PATTERNS:
            if re.match(pattern, q, flags=re.IGNORECASE):
                return True
    return False


def chunk_text(text: str, limit: int = CHUNK_MAX_CHARS) -> list[str]:
    text = normalize_text(text)
    if len(text) <= limit:
        return [text] if len(text) >= CHUNK_MIN_CHARS else []

    parts = []
    paragraphs = re.split(r"\n\s*\n", text)
    current = ""
    for paragraph in paragraphs:
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        if len(current) + len(paragraph) + 2 <= limit:
            current = f"{current}\n\n{paragraph}".strip()
            continue
        if current and len(current) >= CHUNK_MIN_CHARS:
            parts.append(current)
        current = paragraph
        while len(current) > limit:
            parts.append(current[:limit])
            current = current[limit:]
    if current and len(current) >= CHUNK_MIN_CHARS:
        parts.append(current)
    return parts


def chunk_markdown(text: str, source: str, metadata=None) -> list[dict]:
    chunks = []
    sections = re.split(r"\n(?=#{1,3}\s+)", normalize_text(text))
    fallback_title = os.path.splitext(source)[0]
    metadata = normalize_metadata(metadata or {})

    for sec in sections:
        sec = sec.strip()
        if len(sec) < CHUNK_MIN_CHARS:
            continue
        title_m = re.match(r"^#{1,3}\s+(.+)", sec)
        title = title_m.group(1).strip() if title_m else fallback_title
        for i, part in enumerate(chunk_text(sec)):
            chunk_title = title if i == 0 else f"{title} ({i + 1})"
            chunks.append({
                "source": source,
                "title": chunk_title,
                "text": part,
                **metadata,
            })
    return chunks


def load_jsonl_knowledge(jsonl_path: Path, rel: str) -> list[dict]:
    chunks = []
    with jsonl_path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except Exception as e:
                print(f"  [skip] {rel}:{line_no}: {e}", file=sys.stderr)
                continue
            text = normalize_text(str(item.get("text") or item.get("content") or ""))
            if len(text) < CHUNK_MIN_CHARS:
                continue
            title = str(item.get("title") or item.get("id") or f"{rel}:{line_no}")
            source = str(item.get("source") or item.get("source_file") or rel)
            meta = normalize_metadata({
                k: v
                for k, v in item.items()
                if k not in {"text", "content"}
            })
            for i, part in enumerate(chunk_text(text)):
                chunk_title = title if i == 0 else f"{title} ({i + 1})"
                chunks.append({
                    "source": source,
                    "title": chunk_title,
                    "text": part,
                    **meta,
                    "jsonl_source": rel,
                    "jsonl_line": line_no,
                })
    return chunks


def path_allowed(rel: str) -> bool:
    rel = rel.replace("\\", "/").strip("/")
    if INCLUDE_DIRS and not any(rel == d or rel.startswith(f"{d}/") for d in INCLUDE_DIRS):
        return False
    if EXCLUDE_DIRS and any(rel == d or rel.startswith(f"{d}/") for d in EXCLUDE_DIRS):
        return False
    if EXCLUDE_FILES:
        fname = rel.split("/")[-1]
        if any(fnmatch.fnmatch(fname, pat) for pat in EXCLUDE_FILES):
            return False
    return True


def split_relation_from_filename(rel: str) -> tuple[list[str], list[str]]:
    name = Path(rel).stem
    if "-" not in name:
        return [], []
    parts = [CHARACTER_ALIASES.get(p.strip(), p.strip()) for p in name.split("-", 1)]
    if len(parts) != 2 or not all(parts):
        return [], []
    return parts, infer_relation_pairs(parts)


def infer_path_metadata(rel: str) -> dict:
    rel = rel.replace("\\", "/").strip("/")
    meta = {}
    if rel.startswith("05_模型规则/"):
        meta.update({
            "doc_type": "boundary",
            "subjects": ["白鹭千圣"] if "千圣" in rel else [],
            "characters": ["白鹭千圣"] if "千圣" in rel else [],
            "categories": ["model_rule", "boundary", "speech_style", "daily_life", "relationship"],
            "current_validity": "current",
        })
    elif rel.startswith("01_角色/"):
        parts = rel.split("/")
        char = parts[1] if len(parts) > 2 else ""
        name = Path(rel).stem
        doc_type = "profile_dossier"
        categories = ["personality", "speech_style", "daily_life"]
        if "局部事实" in name:
            doc_type = "fact"
            categories = ["identity", "habit_preference", "weakness", "skill", "daily_life"]
        elif "角色弧光" in name:
            doc_type = "timeline"
            categories = ["event_history", "personality"]
        elif "核心语录" in name:
            doc_type = "speech_style"
            categories = ["speech_style"]
        meta.update({
            "doc_type": doc_type,
            "subjects": [char] if char and char != "角色索引" else [],
            "characters": [char] if char and char != "角色索引" else [],
            "categories": categories,
            "current_validity": "current",
        })
    elif rel.startswith("02_关系/"):
        chars, pairs = split_relation_from_filename(rel)
        meta.update({
            "doc_type": "relationship",
            "subjects": chars,
            "characters": chars,
            "relation_pairs": pairs,
            "categories": ["relationship"],
            "current_validity": "current",
        })
    elif rel.startswith("00_全局/"):
        name = Path(rel).stem
        doc_type = "world"
        categories = ["world"]
        if "时间线" in name:
            doc_type = "timeline"
            categories = ["event_history", "timeline"]
        elif "乐队" in name:
            doc_type = "team"
            categories = ["team", "relationship"]
        meta.update({"doc_type": doc_type, "categories": categories, "current_validity": "current"})
    elif rel.startswith("03_团队/"):
        meta.update({
            "doc_type": "team",
            "subjects": [Path(rel).stem],
            "categories": ["team", "relationship"],
            "current_validity": "current",
        })
    elif rel.startswith("04_事件/"):
        meta.update({
            "doc_type": "event_history",
            "categories": ["event_history", "timeline"],
            "current_validity": "current",
        })
    return meta


def load_knowledge() -> list[dict]:
    all_chunks = []
    if not KB_DIR.exists():
        raise FileNotFoundError(f"Knowledge base not found: {KB_DIR}")

    for md_path in sorted(KB_DIR.rglob("*.md")):
        rel = str(md_path.relative_to(KB_DIR)).replace("\\", "/")
        if not path_allowed(rel):
            continue
        try:
            raw = md_path.read_text(encoding="utf-8")
        except Exception as e:
            print(f"  [skip] {rel}: {e}", file=sys.stderr)
            continue
        metadata, text = parse_frontmatter(raw)
        metadata = normalize_metadata({**infer_path_metadata(rel), **metadata})
        all_chunks.extend(chunk_markdown(text, rel, metadata))
    for jsonl_path in sorted(KB_DIR.rglob("*.jsonl")):
        rel = str(jsonl_path.relative_to(KB_DIR)).replace("\\", "/")
        if not path_allowed(rel):
            continue
        try:
            all_chunks.extend(load_jsonl_knowledge(jsonl_path, rel))
        except Exception as e:
            print(f"  [skip] {rel}: {e}", file=sys.stderr)
    return all_chunks


def embedding_text(chunk: dict) -> str:
    meta_bits = []
    for key in ("doc_type", "categories", "subjects", "characters", "relation_pairs", "current_validity", "story_type"):
        value = chunk.get(key)
        if isinstance(value, list):
            value = " ".join(str(v) for v in value)
        if value:
            meta_bits.append(f"{key}: {value}")
    prefix = "\n".join(meta_bits)
    return f"{chunk['title']}\n{prefix}\n{chunk['text']}".strip()


def embed_passages(model, chunks: list[dict]) -> list[np.ndarray]:
    texts = [embedding_text(c) for c in chunks]
    vectors = []
    for start in range(0, len(texts), BATCH_SIZE):
        batch = texts[start:start + BATCH_SIZE]
        vectors.extend(model.passage_embed(batch))
        print(f"Embedded {min(start + len(batch), len(texts))}/{len(texts)}")
    return [np.asarray(v, dtype=np.float32) for v in vectors]


def open_client() -> QdrantClient:
    STORE_DIR.mkdir(parents=True, exist_ok=True)
    return QdrantClient(path=str(STORE_DIR))


def cmd_build():
    print(f"Loading knowledge from: {KB_DIR}")
    chunks = load_knowledge()
    if not chunks:
        print("ERROR: no chunks found!", file=sys.stderr)
        sys.exit(1)
    print(f"Loaded {len(chunks)} chunks")

    print(f"Loading embedding model: {EMBED_MODEL}")
    model = require_embedding()
    vectors = embed_passages(model, chunks)
    if not vectors or not len(vectors[0]):
        raise RuntimeError("embedding model returned no vectors")
    vector_dim = len(vectors[0])

    if STORE_DIR.exists():
        shutil.rmtree(STORE_DIR)
    STORE_DIR.mkdir(parents=True, exist_ok=True)

    client = open_client()
    try:
        client.create_collection(
            COLLECTION_NAME,
            vectors_config=VectorParams(size=vector_dim, distance=Distance.COSINE),
        )

        points = []
        for idx, (chunk, vector) in enumerate(zip(chunks, vectors)):
            payload = {
                "source": chunk.get("source", "unknown"),
                "title": chunk.get("title", "unknown"),
                "text": chunk.get("text", ""),
            }
            for key, value in chunk.items():
                if key in payload or key == "text":
                    continue
                if value is None:
                    continue
                payload[key] = value
            points.append(
                PointStruct(
                    id=idx,
                    vector=vector.tolist(),
                    payload=payload,
                )
            )
            if len(points) >= BATCH_SIZE:
                client.upsert(COLLECTION_NAME, points=points)
                points = []
        if points:
            client.upsert(COLLECTION_NAME, points=points)

        META_FILE.write_text(
            json.dumps(
                {
                    "model": EMBED_MODEL,
                    "dimension": vector_dim,
                    "collection": COLLECTION_NAME,
                    "chunks": len(chunks),
                    "top_k": TOP_K,
                    "min_score": MIN_SCORE,
                    "score_margin": SCORE_MARGIN,
                    "rerank_limit": RERANK_LIMIT,
                    "metadata_aware": True,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    finally:
        client.close()

    print(f"Vector store saved: {STORE_DIR} ({len(chunks)} chunks)")


def infer_characters(text: str, profile: str = "") -> list[str]:
    chars = []
    if profile in PROFILE_CHARACTERS:
        chars.append(PROFILE_CHARACTERS[profile])
    hay = f"{profile} {text}"
    for alias, canonical in CHARACTER_ALIASES.items():
        if alias and alias in hay and canonical not in chars:
            chars.append(canonical)
    return chars


def load_coverage() -> dict:
    coverage_path = KB_DIR / "coverage.json"
    if not coverage_path.exists():
        return {}
    try:
        return json.loads(coverage_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def relation_pair(a: str, b: str) -> str:
    return "-".join(sorted([a, b], key=lambda x: x.encode("utf-8")))


def infer_relation_pairs(chars: list[str]) -> list[str]:
    if len(chars) < 2:
        return []
    pairs = []
    for i in range(len(chars)):
        for j in range(i + 1, len(chars)):
            pair = relation_pair(chars[i], chars[j])
            # Keep existing BangDream relation naming stable for known pairs.
            if set([chars[i], chars[j]]) == set(["白鹭千圣", "丸山彩"]):
                pair = "白鹭千圣-丸山彩"
            elif set([chars[i], chars[j]]) == set(["白鹭千圣", "松原花音"]):
                pair = "白鹭千圣-松原花音"
            elif set([chars[i], chars[j]]) == set(["白鹭千圣", "濑田薰"]):
                pair = "白鹭千圣-濑田薰"
            elif set([chars[i], chars[j]]) == set(["白鹭千圣", "冰川日菜"]):
                pair = "白鹭千圣-冰川日菜"
            pairs.append(pair)
    return pairs


def infer_query_type(text: str, explicit: str = "auto") -> str:
    if explicit and explicit != "auto":
        return explicit
    for name, pattern in QUERY_TYPE_PATTERNS:
        if re.search(pattern, text, flags=re.I):
            return name
    return "general"


def infer_time_policy(text: str, explicit: str = "auto") -> str:
    if explicit and explicit != "auto":
        return explicit
    if re.search(r"过去|以前|曾经|早期|一开始|最初|当时|回忆|小时候|童年", text):
        return "past_allowed"
    return "current"


def query_metadata(query_text: str, profile: str = "", query_type: str = "auto", time_policy: str = "auto") -> dict:
    explicit_chars = infer_characters(query_text, "")
    chars = list(explicit_chars)
    profile_char = PROFILE_CHARACTERS.get(profile)
    if profile_char and profile_char not in chars:
        chars.insert(0, profile_char)
    relation_chars = explicit_chars if len(explicit_chars) >= 2 else chars
    return {
        "profile": profile or "",
        "characters": chars,
        "explicit_characters": explicit_chars,
        "relation_pairs": infer_relation_pairs(relation_chars),
        "explicit_relation_pairs": infer_relation_pairs(explicit_chars),
        "query_type": infer_query_type(query_text, query_type),
        "time_policy": infer_time_policy(query_text, time_policy),
    }


def coverage_allows(qmeta: dict) -> bool:
    coverage = load_coverage()
    if not coverage:
        return True
    covered_chars = set(ensure_list(coverage.get("characters")))
    covered_pairs = set(ensure_list(coverage.get("relation_pairs")))
    profile_char = PROFILE_CHARACTERS.get(qmeta.get("profile"))
    explicit_chars = set(qmeta.get("explicit_characters") or [])
    non_profile_chars = {c for c in explicit_chars if c != profile_char}

    if non_profile_chars and not non_profile_chars.issubset(covered_chars):
        return False

    explicit_pairs = set(qmeta.get("explicit_relation_pairs") or [])
    if explicit_pairs:
        # A query about a relation outside this KB should not be answered from weakly related material.
        if not explicit_pairs & covered_pairs:
            # Allow profile-character questions such as 千圣和小彩 when the covered pair exists
            # under the canonical relation naming.
            return False
    return True


def metadata_query_text(query_text: str, qmeta: dict) -> str:
    parts = [
        query_text,
        f"profile: {qmeta.get('profile', '')}",
        f"query_type: {qmeta.get('query_type', '')}",
        f"characters: {' '.join(qmeta.get('characters', []))}",
        f"relation_pairs: {' '.join(qmeta.get('relation_pairs', []))}",
        f"time_policy: {qmeta.get('time_policy', '')}",
    ]
    return "\n".join(p for p in parts if p.strip())


def overlap_count(a, b) -> int:
    return len(set(ensure_list(a)) & set(ensure_list(b)))


def metadata_boost(payload: dict, qmeta: dict) -> float:
    boost = 0.0
    source = str(payload.get("source") or "")
    doc_type = str(payload.get("doc_type") or payload.get("type") or "")
    categories = ensure_list(payload.get("categories"))
    tags = ensure_list(payload.get("tags"))
    subjects = ensure_list(payload.get("subjects")) + ensure_list(payload.get("characters"))
    relation_pairs = ensure_list(payload.get("relation_pairs"))
    current_validity = str(payload.get("current_validity") or payload.get("current_validity_guess") or "")
    query_type = qmeta.get("query_type") or "general"
    time_policy = qmeta.get("time_policy") or "current"

    char_hits = overlap_count(subjects, qmeta.get("characters", []))
    boost += min(0.18, char_hits * 0.07)

    pair_hits = overlap_count(relation_pairs, qmeta.get("relation_pairs", []))
    boost += min(0.24, pair_hits * 0.18)

    if query_type != "general":
        if query_type in categories or query_type == doc_type:
            boost += 0.14
        if any(f"cat/{query_type}" in tag for tag in tags):
            boost += 0.08
        if query_type == "relationship" and doc_type == "relationship":
            boost += 0.08
        if query_type == "daily_life" and doc_type in {"fact", "profile_dossier"}:
            boost += 0.12

    if doc_type in {"fact", "relationship", "boundary", "timeline", "profile_dossier"}:
        boost += 0.12
    elif doc_type == "raw_chunk":
        boost -= 0.02
    if doc_type == "boundary" and query_type in {"relationship", "daily_life", "speech_style", "general"}:
        boost += 0.08
    if doc_type == query_type:
        boost += 0.10

    if source.startswith("02_关系/core/"):
        boost += 0.14
    elif source.startswith("02_关系/pair/"):
        boost += 0.10
    elif source.startswith("02_关系/00_"):
        boost -= 0.08
    elif source.startswith("02_关系/long_tail/00_"):
        boost -= 0.14
    elif source.startswith("02_关系/long_tail/") and qmeta.get("explicit_relation_pairs") and not relation_pairs:
        boost -= 0.10
    if qmeta.get("explicit_relation_pairs") and doc_type == "relationship" and not relation_pairs:
        boost -= 0.10
    if query_type != "relationship" and doc_type == "relationship" and not qmeta.get("explicit_relation_pairs"):
        boost -= 0.12

    if time_policy == "current":
        if current_validity in {"current", "current_or_future"}:
            boost += 0.08
        elif current_validity == "past_context":
            boost -= 0.10
    elif time_policy == "past_allowed":
        if current_validity == "past_context":
            boost += 0.07
        elif current_validity in {"current", "current_or_future"}:
            boost += 0.03

    return boost


def lexical_overlap_score(query_text: str, text: str) -> float:
    terms = set(re.findall(r"[\u4e00-\u9fffA-Za-z0-9]{2,}", query_text))
    if not terms:
        return 0.0
    hay = text.lower()
    hits = sum(1 for term in terms if term.lower() in hay)
    return min(0.08, hits * 0.02)


def metadata_matches_card(payload: dict, qmeta: dict, text: str = "") -> bool:
    doc_type = str(payload.get("doc_type") or payload.get("type") or "")
    if doc_type not in {"fact", "relationship", "boundary", "timeline", "profile_dossier", "speech_style", "team", "event_history"}:
        return False

    subjects = ensure_list(payload.get("subjects")) + ensure_list(payload.get("characters"))
    relations = ensure_list(payload.get("relation_pairs"))
    categories = ensure_list(payload.get("categories"))
    tags = ensure_list(payload.get("tags"))
    query_type = qmeta.get("query_type") or "general"

    char_hit = overlap_count(subjects, qmeta.get("characters", [])) > 0
    relation_hit = overlap_count(relations, qmeta.get("relation_pairs", [])) > 0
    if not relation_hit and qmeta.get("relation_pairs"):
        qchars = set(qmeta.get("characters", []))
        relation_hit = len(qchars) >= 2 and qchars.issubset(set(subjects))
    if not relation_hit and "白鹭千圣-松原花音" in qmeta.get("relation_pairs", []):
        relation_hit = "pair/chisato-kanon" in tags
    if not relation_hit and "白鹭千圣-丸山彩" in qmeta.get("relation_pairs", []):
        relation_hit = "pair/chisato-aya" in tags
    if not relation_hit and "白鹭千圣-濑田薰" in qmeta.get("relation_pairs", []):
        relation_hit = "pair/chisato-kaoru" in tags
    type_hit = query_type == "general" or query_type == doc_type or query_type in categories
    tag_hit = any(f"cat/{query_type}" in tag for tag in tags)
    boundary_hit = doc_type == "boundary" and query_type in {"relationship", "daily_life", "general"}
    if doc_type == "boundary" and query_type == "speech_style":
        boundary_hit = re.search(r"说话|台词|口吻|心理独白|长篇|克制|精准", text) is not None

    if qmeta.get("relation_pairs"):
        return relation_hit and (type_hit or tag_hit or boundary_hit)
    return char_hit and (type_hit or tag_hit or boundary_hit)


def metadata_card_candidates(qmeta: dict, query_text: str) -> list:
    candidates = []
    if not KB_DIR.exists():
        return candidates
    for md_path in sorted(KB_DIR.rglob("*.md")):
        rel = str(md_path.relative_to(KB_DIR)).replace("\\", "/")
        if not path_allowed(rel):
            continue
        if rel.lower() == "readme.md":
            continue
        try:
            raw = md_path.read_text(encoding="utf-8")
        except Exception:
            continue
        metadata, body = parse_frontmatter(raw)
        metadata = normalize_metadata({**infer_path_metadata(rel), **metadata})
        if not metadata_matches_card(metadata, qmeta, body):
            continue
        title_m = re.search(r"^#\s+(.+)$", body, flags=re.M)
        title = title_m.group(1).strip() if title_m else os.path.splitext(rel)[0]
        text = normalize_text(body)
        if len(text) > RESULT_MAX_CHARS:
            text = text[:RESULT_MAX_CHARS] + "\n\n[...]"
        payload = {
            "source": rel,
            "title": title,
            "text": text,
            **metadata,
        }
        base = 0.74 + lexical_overlap_score(query_text, f"{title}\n{text}")
        candidates.append(SimpleNamespace(payload=payload, score=base))
    return candidates


def format_metadata(payload: dict) -> str:
    parts = []
    for label, key in [
        ("type", "doc_type"),
        ("subjects", "subjects"),
        ("relations", "relation_pairs"),
        ("categories", "categories"),
        ("validity", "current_validity"),
        ("story_type", "story_type"),
    ]:
        value = payload.get(key)
        if not value and key == "doc_type":
            value = payload.get("type")
        if isinstance(value, list):
            value = ", ".join(str(v) for v in value)
        if value:
            parts.append(f"{label}={value}")
    return "; ".join(parts)


def result_allowed_for_query(payload: dict, qmeta: dict) -> bool:
    explicit_pairs = set(qmeta.get("explicit_relation_pairs") or [])
    if not explicit_pairs:
        return True
    doc_type = str(payload.get("doc_type") or payload.get("type") or "")
    relation_pairs = set(ensure_list(payload.get("relation_pairs")))
    if relation_pairs and relation_pairs.isdisjoint(explicit_pairs):
        return False
    return True


def format_result(hit, rerank_score=None) -> str:
    payload = hit.payload or {}
    doc = normalize_text(payload.get("text", ""))
    if len(doc) > RESULT_MAX_CHARS:
        doc = doc[:RESULT_MAX_CHARS] + "\n\n[...]"
    title = payload.get("title", "unknown")
    source = payload.get("source", "unknown")
    score = hit.score if rerank_score is None else rerank_score
    meta = format_metadata(payload)
    meta_line = f"\nmetadata: {meta}" if meta else ""
    return f"【{title}】(来源: {source}, score={score:.3f}){meta_line}\n{doc}"


def cmd_query(
    query_text: str,
    top_k: int,
    min_score: float,
    debug: bool,
    no_skip: bool,
    profile: str = "",
    query_type: str = "auto",
    time_policy: str = "auto",
) -> str:
    query_text = query_text.strip()
    if not no_skip and should_skip_query(query_text):
        if debug:
            print("[rag] skipped casual/empty query", file=sys.stderr)
        return ""
    if not META_FILE.exists():
        if debug:
            print(f"[rag] vector store not found: {STORE_DIR}", file=sys.stderr)
        return ""

    model = require_embedding()
    qmeta = query_metadata(query_text, profile=profile, query_type=query_type, time_policy=time_policy)
    if not coverage_allows(qmeta):
        if debug:
            print(f"[rag] rejected by coverage: {json.dumps(qmeta, ensure_ascii=False)}", file=sys.stderr)
        return ""
    query_vector = np.asarray(next(model.query_embed(metadata_query_text(query_text, qmeta))), dtype=np.float32).tolist()

    client = open_client()
    try:
        hits = client.search(COLLECTION_NAME, query_vector=query_vector, limit=max(top_k, RERANK_LIMIT))
    finally:
        client.close()

    ranked = []
    seen_keys = set()
    for h in [*hits, *metadata_card_candidates(qmeta, query_text)]:
        payload = h.payload or {}
        key = (payload.get("source"), payload.get("title"), payload.get("text"))
        if key in seen_keys:
            continue
        seen_keys.add(key)
        boost = metadata_boost(h.payload or {}, qmeta)
        ranked.append({
            "hit": h,
            "boost": boost,
            "score": float(h.score) + boost,
        })
    ranked.sort(key=lambda item: item["score"], reverse=True)

    # Build a set of character fact sources (人物画像 + 局部事实) for two-stage retrieval.
    # When the query involves character names, basic facts (school, birthday, etc.)
    # live in these docs and should not be crowded out by relationship docs.
    fact_sources = set()
    for char in qmeta.get("characters", []):
        fact_sources.add(f"01_角色/{char}/人物画像.md")
        fact_sources.add(f"01_角色/{char}/局部事实.md")

    selected = []
    selected_sources = set()

    # Stage 1: character fact documents first (grounding against hallucination).
    # Cap at top_k - 1 so at least one slot remains for relationship/context docs.
    stage1_limit = max(1, top_k - 1) if len(fact_sources) > 1 else top_k
    for item in ranked:
        if len(selected) >= stage1_limit:
            break
        if item["score"] < min_score:
            continue
        if not result_allowed_for_query(item["hit"].payload or {}, qmeta):
            continue
        source = (item["hit"].payload or {}).get("source")
        if source not in fact_sources:
            continue
        if source in selected_sources:
            continue
        selected_sources.add(source)
        selected.append(item)

    # Stage 2: fill remaining slots from all other sources
    for item in ranked:
        if len(selected) >= top_k:
            break
        if item["score"] < min_score:
            continue
        if not result_allowed_for_query(item["hit"].payload or {}, qmeta):
            continue
        source = (item["hit"].payload or {}).get("source")
        if source in selected_sources:
            continue
        selected_sources.add(source)
        selected.append(item)
        if len(selected) >= top_k:
            break
    if debug:
        print(f"[rag] query_meta={json.dumps(qmeta, ensure_ascii=False)}", file=sys.stderr)
        for item in ranked[:max(top_k, 8)]:
            h = item["hit"]
            payload = h.payload or {}
            print(
                f"[rag] base={h.score:.3f} boost={item['boost']:.3f} final={item['score']:.3f} source={payload.get('source')} title={payload.get('title')}",
                file=sys.stderr,
            )
    if not selected:
        return ""
    return "\n\n---\n\n".join(format_result(item["hit"], item["score"]) for item in selected)


def main():
    global RESULT_MAX_CHARS
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("build")

    qp = sub.add_parser("query")
    qp.add_argument("text", nargs="*")
    qp.add_argument("--file", default=None, help="Read query from file instead of command line")
    qp.add_argument("--top-k", type=int, default=TOP_K)
    qp.add_argument("--min-score", type=float, default=MIN_SCORE)
    qp.add_argument("--result-max-chars", type=int, default=RESULT_MAX_CHARS)
    qp.add_argument("--profile", default="", help="Active role/profile name, e.g. 白鹭千圣")
    qp.add_argument("--query-type", default="auto", help="auto, relationship, speech_style, personality, ...")
    qp.add_argument("--time-policy", default="auto", help="auto, current, past_allowed")
    qp.add_argument("--debug", action="store_true")
    qp.add_argument("--no-skip", action="store_true")

    args = parser.parse_args()
    if args.cmd == "build":
        cmd_build()
        return

    if args.file:
        query_str = Path(args.file).read_text(encoding="utf-8").strip()
    else:
        query_str = " ".join(args.text)
    RESULT_MAX_CHARS = max(100, int(args.result_max_chars or RESULT_MAX_CHARS))
    result = cmd_query(
        query_str,
        args.top_k,
        args.min_score,
        args.debug,
        args.no_skip,
        profile=args.profile,
        query_type=args.query_type,
        time_policy=args.time_policy,
    )
    if result:
        print(result)


if __name__ == "__main__":
    main()
