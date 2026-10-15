"""
Gateway do Sensor de Umidade do Solo.

Lê as linhas JSON que o Arduino envia pela Serial, grava cada leitura em um
banco SQLite e publica o dashboard + API na rede local.

Uso:
    python app.py                      # detecta a porta do Arduino automaticamente
    python app.py --porta /dev/ttyACM0 # Linux  (Windows: --porta COM3)
    python app.py --porta rfc2217://localhost:4000   # simulador Wokwi (VS Code)
    python app.py --simular            # sem Arduino: gera dados de teste
"""

import argparse
import json
import logging
import math
import random
import socket
import sqlite3
import threading
import time
from pathlib import Path

import serial
import serial.tools.list_ports
from flask import Flask, jsonify, request

# Mesmos valores do firmware (arduino/sensor_umidade/sensor_umidade.ino)
LIMITE_SECO = 30
LIMITE_UMIDO = 60
HISTERESE = 5
LEITURA_SECO = 20
LEITURA_MOLHADO = 700

ESTADOS_VALIDOS = {"seco", "atencao", "umido"}
OFFLINE_APOS_S = 10       # sem leitura há mais que isso = sensor offline
RETENCAO_DIAS = 30
PONTOS_GRAFICO = 240      # quantidade máxima de pontos devolvidos no histórico

BASE = Path(__file__).resolve().parent
log = logging.getLogger("gateway")

app = Flask(__name__, static_folder=str(BASE / "static"), static_url_path="")

_ultima = {"leitura": None}
_trava = threading.Lock()
_config = {"banco": BASE / "umidade.db", "modo": "serial"}


# ---------------------------------------------------------------- banco

def conectar():
    conexao = sqlite3.connect(_config["banco"], timeout=10)
    conexao.row_factory = sqlite3.Row
    return conexao


def iniciar_banco():
    with conectar() as db:
        db.execute(
            """CREATE TABLE IF NOT EXISTS leituras (
                   ts REAL NOT NULL,
                   raw INTEGER NOT NULL,
                   umidade INTEGER NOT NULL,
                   estado TEXT NOT NULL
               )"""
        )
        db.execute("CREATE INDEX IF NOT EXISTS idx_leituras_ts ON leituras (ts)")
        db.execute("DELETE FROM leituras WHERE ts < ?", (time.time() - RETENCAO_DIAS * 86400,))
        ultima = db.execute("SELECT * FROM leituras ORDER BY ts DESC LIMIT 1").fetchone()
    if ultima:
        _ultima["leitura"] = dict(ultima)


def registrar(raw, umidade, estado, ts=None, db=None):
    leitura = {"ts": ts or time.time(), "raw": raw, "umidade": umidade, "estado": estado}
    fechar = db is None
    db = db or conectar()
    try:
        db.execute(
            "INSERT INTO leituras (ts, raw, umidade, estado) VALUES (:ts, :raw, :umidade, :estado)",
            leitura,
        )
        db.commit()
    finally:
        if fechar:
            db.close()
    with _trava:
        _ultima["leitura"] = leitura


# ---------------------------------------------------------------- serial

def detectar_porta():
    for porta in serial.tools.list_ports.comports():
        descricao = f"{porta.description} {porta.manufacturer or ''}".lower()
        if any(p in descricao for p in ("arduino", "ch340", "usb serial", "acm")) or "ttyACM" in porta.device:
            return porta.device
    return None


def interpretar_linha(linha):
    """Valida uma linha JSON do Arduino. Retorna (raw, umidade, estado) ou None."""
    try:
        dados = json.loads(linha)
        raw = int(dados["raw"])
        umidade = int(dados["umidade"])
        estado = str(dados["estado"])
    except (ValueError, KeyError, TypeError):
        return None
    if not 0 <= umidade <= 100 or estado not in ESTADOS_VALIDOS:
        return None
    return raw, umidade, estado


def ler_serial(porta, baud):
    """Loop infinito: conecta, lê linhas e reconecta se o cabo for desligado."""
    db = conectar()
    while True:
        url = porta or detectar_porta()
        if not url:
            log.warning("Arduino não encontrado. Conecte o cabo USB ou use --porta. Tentando de novo em 3 s...")
            time.sleep(3)
            continue
        try:
            with serial.serial_for_url(url, baud, timeout=5) as conexao:
                log.info("Conectado ao Arduino em %s", url)
                while True:
                    linha = conexao.readline().decode("utf-8", errors="ignore").strip()
                    if not linha:
                        continue
                    leitura = interpretar_linha(linha)
                    if leitura:
                        registrar(*leitura, db=db)
                    else:
                        log.debug("Linha ignorada: %r", linha)
        except (serial.SerialException, OSError) as erro:
            log.warning("Conexão serial perdida (%s). Reconectando em 3 s...", erro)
            time.sleep(3)


# ---------------------------------------------------------------- simulação

def classificar(umidade, atual):
    """Mesma lógica com histerese do firmware."""
    if atual == "seco":
        if umidade >= LIMITE_UMIDO:
            return "umido"
        return "atencao" if umidade >= LIMITE_SECO + HISTERESE else "seco"
    if atual == "umido":
        if umidade < LIMITE_SECO:
            return "seco"
        return "atencao" if umidade < LIMITE_UMIDO - HISTERESE else "umido"
    if umidade < LIMITE_SECO:
        return "seco"
    return "umido" if umidade >= LIMITE_UMIDO else "atencao"


def percentual_para_raw(umidade):
    return round(LEITURA_SECO + (LEITURA_MOLHADO - LEITURA_SECO) * umidade / 100)


class Planta:
    """Modelo simples: o solo seca aos poucos (mais rápido de dia) e é regado quando fica seco."""

    def __init__(self, umidade=85.0):
        self.umidade = umidade
        self.estado = classificar(round(umidade), "atencao")
        self.regar_abaixo = random.uniform(18, 28)

    def avancar(self, ts, segundos, perda_por_hora):
        hora = time.localtime(ts).tm_hour + time.localtime(ts).tm_min / 60
        fator_dia = 1 + 0.6 * math.sin((hora - 8) / 24 * 2 * math.pi)
        self.umidade -= perda_por_hora * fator_dia * segundos / 3600
        if self.umidade < self.regar_abaixo:
            self.umidade = random.uniform(82, 94)
            self.regar_abaixo = random.uniform(18, 28)
        leitura = max(0, min(100, round(self.umidade + random.uniform(-0.8, 0.8))))
        self.estado = classificar(leitura, self.estado)
        return percentual_para_raw(leitura), leitura, self.estado


def simular():
    db = conectar()
    planta = Planta()
    vazio = db.execute("SELECT COUNT(*) FROM leituras").fetchone()[0] == 0
    if vazio:
        log.info("Gerando 7 dias de histórico simulado...")
        agora = time.time()
        passo = 300
        for ts in range(int(agora - 7 * 86400), int(agora), passo):
            raw, umidade, estado = planta.avancar(ts, passo, perda_por_hora=2.5)
            db.execute(
                "INSERT INTO leituras (ts, raw, umidade, estado) VALUES (?, ?, ?, ?)",
                (ts, raw, umidade, estado),
            )
        db.commit()
    else:
        ultima = _ultima["leitura"]
        planta = Planta(ultima["umidade"]) if ultima else planta

    # Ao vivo o solo seca mais rápido (30 %/h) para a mudança ser visível na apresentação.
    while True:
        registrar(*planta.avancar(time.time(), 2, perda_por_hora=30), db=db)
        time.sleep(2)


# ---------------------------------------------------------------- API

@app.get("/")
def index():
    return app.send_static_file("index.html")


@app.get("/api/atual")
def api_atual():
    with _trava:
        leitura = dict(_ultima["leitura"]) if _ultima["leitura"] else None
    idade = time.time() - leitura["ts"] if leitura else None
    return jsonify(
        leitura=leitura,
        online=idade is not None and idade <= OFFLINE_APOS_S,
        idade_s=idade,
        modo=_config["modo"],
        limites={"seco": LIMITE_SECO, "umido": LIMITE_UMIDO},
    )


@app.get("/api/historico")
def api_historico():
    horas = min(max(request.args.get("horas", 24, type=float), 0.25), 24 * RETENCAO_DIAS)
    inicio = time.time() - horas * 3600
    balde = max(horas * 3600 / PONTOS_GRAFICO, 2)
    with conectar() as db:
        pontos = db.execute(
            """SELECT CAST(ts / :b AS INTEGER) * :b + :b / 2 AS ts,
                      ROUND(AVG(umidade), 1) AS umidade,
                      MIN(umidade) AS minimo,
                      MAX(umidade) AS maximo
               FROM leituras WHERE ts >= :inicio
               GROUP BY CAST(ts / :b AS INTEGER) ORDER BY 1""",
            {"b": balde, "inicio": inicio},
        ).fetchall()
        resumo = db.execute(
            """SELECT ROUND(AVG(umidade), 1) AS media, MIN(umidade) AS minimo,
                      MAX(umidade) AS maximo, COUNT(*) AS leituras,
                      ROUND(100.0 * SUM(estado = 'seco') / COUNT(*), 1) AS pct_seco
               FROM leituras WHERE ts >= ?""",
            (inicio,),
        ).fetchone()
    return jsonify(horas=horas, balde_s=balde, pontos=[dict(p) for p in pontos], resumo=dict(resumo))


# ---------------------------------------------------------------- main

def ip_local():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def main():
    parser = argparse.ArgumentParser(description="Gateway e dashboard do sensor de umidade do solo")
    parser.add_argument("--porta", help="porta serial do Arduino (ex.: /dev/ttyACM0, COM3, rfc2217://localhost:4000)")
    parser.add_argument("--baud", type=int, default=9600)
    parser.add_argument("--simular", action="store_true", help="gera dados de teste sem Arduino")
    parser.add_argument("--host", default="0.0.0.0", help="0.0.0.0 = acessível por toda a rede local")
    parser.add_argument("--http-porta", type=int, default=5000)
    parser.add_argument("--banco", type=Path, help="arquivo SQLite (padrão: umidade.db ou umidade_sim.db)")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    logging.getLogger("werkzeug").setLevel(logging.WARNING)

    _config["modo"] = "simulacao" if args.simular else "serial"
    _config["banco"] = args.banco or BASE / ("umidade_sim.db" if args.simular else "umidade.db")
    iniciar_banco()

    alvo = simular if args.simular else lambda: ler_serial(args.porta, args.baud)
    threading.Thread(target=alvo, daemon=True, name="coleta").start()

    print(f"\n  Dashboard:  http://localhost:{args.http_porta}")
    print(f"  Na rede:    http://{ip_local()}:{args.http_porta}   <- abra no celular (mesmo Wi-Fi)\n")
    app.run(host=args.host, port=args.http_porta, threaded=True)


if __name__ == "__main__":
    main()
