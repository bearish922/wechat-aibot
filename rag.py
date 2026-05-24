# -*- coding: utf-8 -*-
"""BangDream Knowledge RAG using local embeddings and a Qdrant vector store.

build: parse markdown knowledge files, embed chunks, and persist them in Qdrant.
query: embed the user message, search the local vector store, and return context.
"""

import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path

import numpy as np
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, PointStruct, VectorParams

try:
    from fastembed import TextEmbedding
except ImportError:
    TextEmbedding = None


BASE_DIR = Path(__file__).parent
CONFIG_FILE = BASE_DIR / "config.json"


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


def cfg_path(key: str, default) -> Path:
    raw = os.environ.get(f"WEIXIN_{key.upper().replace('.', '_')}") or cfg(key, str(default))
    p = Path(raw)
    return p if p.is_absolute() else BASE_DIR / p


KB_DIR = cfg_path("rag.knowledgeDir", r"D:\Desktop\Obsidian\entertainment\Bangdream-Knowledge")
STORE_DIR = cfg_path("rag.storeDir", BASE_DIR / "rag_vector_store")
MODEL_CACHE_DIR = cfg_path("rag.modelCacheDir", BASE_DIR / ".fastembed_cache")
META_FILE = STORE_DIR / "rag_meta.json"
COLLECTION_NAME = str(cfg("rag.collectionName", "bangdream_knowledge"))

EMBED_MODEL = os.environ.get("WEIXIN_RAG_EMBED_MODEL") or str(cfg("rag.embedModel", "BAAI/bge-small-zh-v1.5"))
EMBED_DIM = 512
TOP_K = cfg_int("rag.topK", 3)
MIN_SCORE = cfg_float("rag.minScore", 0.48)
SCORE_MARGIN = cfg_float("rag.scoreMargin", 0.16)
CHUNK_MIN_CHARS = 80
CHUNK_MAX_CHARS = cfg_int("rag.chunkMaxChars", 1600)
RESULT_MAX_CHARS = cfg_int("rag.resultMaxChars", 1200)
BATCH_SIZE = cfg_int("rag.batchSize", 32)

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


def chunk_markdown(text: str, source: str) -> list[dict]:
    chunks = []
    sections = re.split(r"\n(?=#{1,3}\s+)", normalize_text(text))
    fallback_title = os.path.splitext(source)[0]

    for sec in sections:
        sec = sec.strip()
        if len(sec) < CHUNK_MIN_CHARS:
            continue
        title_m = re.match(r"^#{1,3}\s+(.+)", sec)
        title = title_m.group(1).strip() if title_m else fallback_title
        for i, part in enumerate(chunk_text(sec)):
            chunk_title = title if i == 0 else f"{title} ({i + 1})"
            chunks.append({"source": source, "title": chunk_title, "text": part})
    return chunks


def load_knowledge() -> list[dict]:
    all_chunks = []
    if not KB_DIR.exists():
        raise FileNotFoundError(f"Knowledge base not found: {KB_DIR}")

    for md_path in sorted(KB_DIR.rglob("*.md")):
        rel = str(md_path.relative_to(KB_DIR)).replace("\\", "/")
        try:
            text = md_path.read_text(encoding="utf-8")
        except Exception as e:
            print(f"  [skip] {rel}: {e}", file=sys.stderr)
            continue
        all_chunks.extend(chunk_markdown(text, rel))
    return all_chunks


def embed_passages(model, chunks: list[dict]) -> list[np.ndarray]:
    texts = [f"{c['title']}\n{c['text']}" for c in chunks]
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

    if STORE_DIR.exists():
        shutil.rmtree(STORE_DIR)
    STORE_DIR.mkdir(parents=True, exist_ok=True)

    client = open_client()
    try:
        client.create_collection(
            COLLECTION_NAME,
            vectors_config=VectorParams(size=EMBED_DIM, distance=Distance.COSINE),
        )

        points = []
        for idx, (chunk, vector) in enumerate(zip(chunks, vectors)):
            points.append(
                PointStruct(
                    id=idx,
                    vector=vector.tolist(),
                    payload={
                        "source": chunk["source"],
                        "title": chunk["title"],
                        "text": chunk["text"],
                    },
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
                    "dimension": EMBED_DIM,
                    "collection": COLLECTION_NAME,
                    "chunks": len(chunks),
                    "top_k": TOP_K,
                    "min_score": MIN_SCORE,
                    "score_margin": SCORE_MARGIN,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    finally:
        client.close()

    print(f"Vector store saved: {STORE_DIR} ({len(chunks)} chunks)")


def format_result(hit) -> str:
    payload = hit.payload or {}
    doc = normalize_text(payload.get("text", ""))
    if len(doc) > RESULT_MAX_CHARS:
        doc = doc[:RESULT_MAX_CHARS] + "\n\n[...]"
    title = payload.get("title", "unknown")
    source = payload.get("source", "unknown")
    return f"【{title}】(来源: {source}, score={hit.score:.3f})\n{doc}"


def cmd_query(query_text: str, top_k: int, min_score: float, debug: bool, no_skip: bool) -> str:
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
    query_vector = np.asarray(next(model.query_embed(query_text)), dtype=np.float32).tolist()

    client = open_client()
    try:
        hits = client.search(COLLECTION_NAME, query_vector=query_vector, limit=top_k)
    finally:
        client.close()

    best_score = hits[0].score if hits else 0.0
    selected = [
        h for h in hits
        if h.score >= min_score and h.score >= best_score - SCORE_MARGIN
    ]
    if debug:
        for h in hits:
            payload = h.payload or {}
            print(
                f"[rag] score={h.score:.3f} source={payload.get('source')} title={payload.get('title')}",
                file=sys.stderr,
            )
    if not selected:
        return ""
    return "\n\n---\n\n".join(format_result(h) for h in selected)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("build")

    qp = sub.add_parser("query")
    qp.add_argument("text", nargs="*")
    qp.add_argument("--file", default=None, help="Read query from file instead of command line")
    qp.add_argument("--top-k", type=int, default=TOP_K)
    qp.add_argument("--min-score", type=float, default=MIN_SCORE)
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
    result = cmd_query(query_str, args.top_k, args.min_score, args.debug, args.no_skip)
    if result:
        print(result)


if __name__ == "__main__":
    main()
