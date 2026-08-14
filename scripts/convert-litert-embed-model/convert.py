"""
Produces the .tflite model bundled at public/models/all-MiniLM-L6-v2-litert/
(loaded by src/offscreen/localEmbed.ts). sentence-transformers/all-MiniLM-L6-v2,
mean-pooling + L2-normalize baked into the graph, fixed batch=8 (matches
localEmbed.ts's EMBED_BATCH) / seq_len=256, exported to .tflite, then
weight-only int8 quantized via ai-edge-quantizer's dynamic_wi8_afp32 recipe.
Validates the final int8 model's cosine similarity against the torch fp32
reference and fails loudly if quality drops below an acceptable floor.

Usage (needs Python 3.10 or 3.11 -- litert-torch does not yet support 3.12+):
    uv venv --python 3.11 .venv && source .venv/bin/activate
    uv pip install -r requirements.txt
    python convert.py
    # copy the resulting all-MiniLM-L6-v2-pooled.int8.tflite and
    # tokenizer_assets/{tokenizer.json,tokenizer_config.json} into
    # public/models/all-MiniLM-L6-v2-litert/ as model.int8.tflite,
    # tokenizer.json, tokenizer_config.json respectively.
"""
import sys
import numpy as np
import torch
import torch.nn as nn
from transformers import AutoModel, AutoTokenizer
from ai_edge_quantizer import Quantizer
from ai_edge_quantizer.recipe import dynamic_wi8_afp32
from ai_edge_litert.interpreter import Interpreter
import litert_torch as lt

MODEL_ID = "sentence-transformers/all-MiniLM-L6-v2"
SEQ_LEN = 256
BATCH = 8
MIN_COSINE_SIMILARITY = 0.97


class EmbedderWithPooling(nn.Module):
    """Exposes int32 inputs (LiteRT.js's Tensor class only supports
    float32/int32/uint8 -- no int64) and upcasts to int64 internally for the
    HF embedding lookup, which needs int64 indices."""

    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, input_ids, attention_mask, token_type_ids):
        out = self.model(
            input_ids=input_ids.to(torch.int64),
            attention_mask=attention_mask.to(torch.int64),
            token_type_ids=token_type_ids.to(torch.int64),
        )
        token_embeddings = out[0]
        mask = attention_mask.unsqueeze(-1).expand(token_embeddings.size()).float()
        summed = torch.sum(token_embeddings * mask, dim=1)
        counts = torch.clamp(mask.sum(dim=1), min=1e-9)
        mean_pooled = summed / counts
        return nn.functional.normalize(mean_pooled, p=2, dim=1)


def pad_to_batch(sentences, batch):
    out = list(sentences)
    while len(out) % batch != 0:
        out.append("")
    return out


def main():
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    base_model = AutoModel.from_pretrained(MODEL_ID)
    base_model.eval()
    wrapped = EmbedderWithPooling(base_model)
    wrapped.eval()

    trace_sentences = [f"Sample calibration sentence number {i} for tracing the graph." for i in range(BATCH)]
    enc = tokenizer(trace_sentences, padding="max_length", truncation=True, max_length=SEQ_LEN, return_tensors="pt")
    args = (
        enc["input_ids"].to(torch.int32),
        enc["attention_mask"].to(torch.int32),
        enc["token_type_ids"].to(torch.int32),
    )

    print(f"Converting float32 (.tflite, batch={BATCH}, seq_len={SEQ_LEN})...")
    edge_model = lt.convert(wrapped, args)
    edge_model.export("all-MiniLM-L6-v2-pooled.f32.tflite")

    quantizer = Quantizer("all-MiniLM-L6-v2-pooled.f32.tflite", quantization_recipe=dynamic_wi8_afp32())
    result = quantizer.quantize()
    result.export_model("all-MiniLM-L6-v2-pooled.int8.tflite", overwrite=True)
    print("Wrote all-MiniLM-L6-v2-pooled.int8.tflite")

    # --- validation: varied real sentences, different from the tracing/calibration set ---
    eval_sentences_raw = [
        "The quick brown fox jumps over the lazy dog.",
        "CANChat-Agent stores document chunks and embeddings in OPFS.",
        "Parsing PDFs is fast; embedding is the slow step in document ingestion.",
        "Local on-device embedding runs entirely in the browser via WebAssembly or WebGPU.",
        "Vector search retrieves the most relevant chunks for a query using cosine similarity.",
        "",
        "1234567890 numbers and punctuation! Does it handle these correctly?",
        "A considerably longer sentence meant to exercise more of the sequence length so we "
        "can see how the quantized model behaves on inputs that are not short toy examples.",
    ]
    eval_sentences = pad_to_batch(eval_sentences_raw, BATCH)
    eval_enc = tokenizer(eval_sentences, padding="max_length", truncation=True, max_length=SEQ_LEN, return_tensors="pt")
    with torch.no_grad():
        torch_out = wrapped(eval_enc["input_ids"], eval_enc["attention_mask"], eval_enc["token_type_ids"]).numpy()
    torch_out = torch_out[: len(eval_sentences_raw)]

    interp = Interpreter(model_path="all-MiniLM-L6-v2-pooled.int8.tflite")
    interp.allocate_tensors()
    input_details = interp.get_input_details()
    output_details = interp.get_output_details()
    ordered_keys = ["input_ids", "attention_mask", "token_type_ids"]
    enc_np = {k: v.numpy() for k, v in eval_enc.items()}

    int8_out_batches = []
    for i in range(0, len(eval_sentences), BATCH):
        for pos, d in enumerate(input_details):
            val = enc_np[ordered_keys[pos]][i : i + BATCH]
            interp.set_tensor(d["index"], val.astype(d["dtype"]))
        interp.invoke()
        int8_out_batches.append(interp.get_tensor(output_details[0]["index"]).copy())
    int8_out = np.concatenate(int8_out_batches, axis=0)[: len(eval_sentences_raw)]

    cos = (int8_out * torch_out).sum(axis=1) / (
        np.linalg.norm(int8_out, axis=1) * np.linalg.norm(torch_out, axis=1) + 1e-9
    )
    print("Per-sample cosine similarity (int8 tflite vs torch fp32 reference):")
    for s, c in zip(eval_sentences_raw, cos):
        print(f"  {c:.5f}  {s[:60]!r}")
    print(f"min={cos.min():.5f} mean={cos.mean():.5f}")

    if cos.min() < MIN_COSINE_SIMILARITY:
        print(f"FAIL: min cosine similarity {cos.min():.5f} below floor {MIN_COSINE_SIMILARITY}", file=sys.stderr)
        sys.exit(1)
    print("PASS: quantized model meets the similarity floor.")

    tokenizer.save_pretrained("tokenizer_assets")


if __name__ == "__main__":
    main()
