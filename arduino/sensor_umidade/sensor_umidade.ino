/*
 * Sensor de Umidade do Solo - Arduino Uno
 *
 * Lê a umidade do solo em A0, indica o estado da planta com LEDs (o vermelho
 * pisca quando o solo está seco) e envia uma linha JSON pela Serial a cada
 * INTERVALO_LEITURA_MS para o servidor/dashboard:
 *
 *   {"raw":412,"umidade":47,"estado":"atencao"}
 *
 * Ligações - sensor caseiro (2 hastes + resistor 10k do kit):
 *   D7 -> haste 1 (fica no solo)
 *   haste 2 (fica no solo) -> A0
 *   A0 -> resistor 10k -> GND
 *
 * Ligações - sensor capacitivo v1.2 (se comprar um):
 *   VCC -> 5V | GND -> GND | AOUT -> A0   (e recalibre, veja docs/calibracao.md)
 *
 * LEDs:
 *   LED verde    -> D2 (resistor 220R)
 *   LED amarelo  -> D3 (resistor 220R)
 *   LED vermelho -> D4 (resistor 220R)
 *   Buzzer (+)   -> D5 (opcional, não vem no kit)
 */

// ---------------- Pinos ----------------
const uint8_t PINO_SENSOR   = A0;
const uint8_t PINO_LED_VERDE    = 2;
const uint8_t PINO_LED_AMARELO  = 3;
const uint8_t PINO_LED_VERMELHO = 4;
const uint8_t PINO_BUZZER   = 5;   // opcional
// Alimenta as hastes só durante a leitura: com corrente contínua o tempo todo,
// o metal sofre eletrólise e corrói em poucos dias.
const uint8_t PINO_ALIMENTACAO_SENSOR = 7;

// ---------------- Calibração ----------------
// Veja docs/calibracao.md. Anote a leitura "raw" com o sensor em solo bem
// seco e em solo encharcado. A ordem pode ser crescente ou decrescente:
//   sensor caseiro:     seco = valor BAIXO  (ex.: 20 / 700)
//   sensor capacitivo:  seco = valor ALTO   (ex.: 520 / 260)
const int LEITURA_SECO    = 20;
const int LEITURA_MOLHADO = 700;

// ---------------- Limites (%) ----------------
const int LIMITE_SECO   = 30;  // abaixo disso: planta precisa de água
const int LIMITE_UMIDO  = 60;  // a partir disso: solo úmido
const int HISTERESE     = 5;   // evita o estado "piscar" perto dos limites

// ---------------- Tempos ----------------
const unsigned long INTERVALO_LEITURA_MS = 2000;
const unsigned long INTERVALO_BIPE_MS    = 5000;  // bipe a cada 5 s quando seco
const unsigned long DURACAO_BIPE_MS      = 150;
const unsigned long PISCA_LED_MS         = 500;   // LED vermelho pisca quando seco
const unsigned long ESTABILIZACAO_MS     = 10;    // espera após ligar as hastes
const uint8_t AMOSTRAS = 10;

enum Estado { SECO, ATENCAO, UMIDO };

Estado estadoAtual = ATENCAO;
unsigned long ultimaLeitura = 0;
unsigned long ultimoBipe = 0;

int lerSensorMedia() {
  digitalWrite(PINO_ALIMENTACAO_SENSOR, HIGH);
  delay(ESTABILIZACAO_MS);
  long soma = 0;
  for (uint8_t i = 0; i < AMOSTRAS; i++) {
    soma += analogRead(PINO_SENSOR);
    delay(5);
  }
  digitalWrite(PINO_ALIMENTACAO_SENSOR, LOW);
  return soma / AMOSTRAS;
}

int converterParaPercentual(int leitura) {
  int percentual = map(leitura, LEITURA_SECO, LEITURA_MOLHADO, 0, 100);
  return constrain(percentual, 0, 100);
}

// O limite para SAIR de um estado fica HISTERESE pontos além do limite para
// ENTRAR nele, assim pequenas oscilações não trocam o estado.
Estado classificar(int umidade, Estado atual) {
  switch (atual) {
    case SECO:
      if (umidade >= LIMITE_UMIDO) return UMIDO;
      if (umidade >= LIMITE_SECO + HISTERESE) return ATENCAO;
      return SECO;
    case UMIDO:
      if (umidade < LIMITE_SECO) return SECO;
      if (umidade < LIMITE_UMIDO - HISTERESE) return ATENCAO;
      return UMIDO;
    default:  // ATENCAO
      if (umidade < LIMITE_SECO) return SECO;
      if (umidade >= LIMITE_UMIDO) return UMIDO;
      return ATENCAO;
  }
}

const char* nomeEstado(Estado estado) {
  switch (estado) {
    case SECO:  return "seco";
    case UMIDO: return "umido";
    default:    return "atencao";
  }
}

void atualizarLeds(Estado estado) {
  digitalWrite(PINO_LED_VERDE,   estado == UMIDO);
  digitalWrite(PINO_LED_AMARELO, estado == ATENCAO);
}

// Não bloqueante: quando seco, pisca o LED vermelho e bipa o buzzer (se houver)
// por DURACAO_BIPE_MS a cada INTERVALO_BIPE_MS.
void atualizarAlerta(Estado estado, unsigned long agora) {
  if (estado != SECO) {
    digitalWrite(PINO_LED_VERMELHO, LOW);
    digitalWrite(PINO_BUZZER, LOW);
    return;
  }
  digitalWrite(PINO_LED_VERMELHO, (agora / PISCA_LED_MS) % 2 == 0);
  if (agora - ultimoBipe >= INTERVALO_BIPE_MS) {
    ultimoBipe = agora;
  }
  digitalWrite(PINO_BUZZER, agora - ultimoBipe < DURACAO_BIPE_MS);
}

void enviarJson(int leitura, int umidade, Estado estado) {
  Serial.print(F("{\"raw\":"));
  Serial.print(leitura);
  Serial.print(F(",\"umidade\":"));
  Serial.print(umidade);
  Serial.print(F(",\"estado\":\""));
  Serial.print(nomeEstado(estado));
  Serial.println(F("\"}"));
}

void setup() {
  Serial.begin(9600);
  pinMode(PINO_LED_VERDE, OUTPUT);
  pinMode(PINO_LED_AMARELO, OUTPUT);
  pinMode(PINO_LED_VERMELHO, OUTPUT);
  pinMode(PINO_BUZZER, OUTPUT);
  pinMode(PINO_ALIMENTACAO_SENSOR, OUTPUT);
  digitalWrite(PINO_ALIMENTACAO_SENSOR, LOW);

  // Primeira leitura imediata para não começar num estado arbitrário.
  int umidade = converterParaPercentual(lerSensorMedia());
  estadoAtual = umidade < LIMITE_SECO ? SECO : (umidade >= LIMITE_UMIDO ? UMIDO : ATENCAO);
}

void loop() {
  unsigned long agora = millis();

  if (agora - ultimaLeitura >= INTERVALO_LEITURA_MS) {
    ultimaLeitura = agora;
    int leitura = lerSensorMedia();
    int umidade = converterParaPercentual(leitura);
    estadoAtual = classificar(umidade, estadoAtual);
    atualizarLeds(estadoAtual);
    enviarJson(leitura, umidade, estadoAtual);
  }

  atualizarAlerta(estadoAtual, agora);
}
