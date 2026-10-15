# Sensor e calibração

## Montando o sensor caseiro (só com peças do kit)

O kit não traz um sensor de umidade, mas dá para fazer um com **2 hastes metálicas** e um
**resistor de 10 kΩ**. O princípio é simples: a água conduz eletricidade. Quanto mais úmida
a terra, menor a resistência entre as hastes e maior a tensão que chega em A0.

```
 D7 ──────────── haste 1 ┐
                          │  (terra entre as hastes)
 A0 ──┬───────── haste 2 ┘
      │
    [10kΩ]
      │
 GND ─┘
```

**Hastes:** servem dois pregos galvanizados, dois pedaços de fio rígido desencapado ou duas
pontas de jumper. Prenda um jumper em cada uma e enterre as duas a **2–3 cm uma da outra**,
na mesma profundidade (5–8 cm), perto da raiz.

**Por que D7 e não 5V?** O firmware liga D7 só durante a leitura, por cerca de 60 ms a cada
2 s. Com corrente contínua o tempo todo, as hastes sofreriam eletrólise e corroeriam em
poucos dias.

**Dica:** se as leituras ficarem todas muito baixas, mesmo com a terra úmida, troque o
resistor de 10 kΩ pelo de **100 kΩ** (também vem no kit) para aumentar a sensibilidade.
Depois recalibre.

> Com um **sensor capacitivo v1.2** (cerca de R$ 15, recomendado para uso prolongado), ligue
> VCC → 5V, GND → GND, AOUT → A0, dispense o resistor e recalibre. Nele a leitura
> **diminui** com a umidade, e o código aceita os dois sentidos.

## Calibração passo a passo

Cada sensor e cada tipo de terra dão leituras diferentes. Calibrar leva 5 minutos e faz a
porcentagem ficar correta.

1. Grave o firmware `arduino/sensor_umidade/sensor_umidade.ino` no Arduino.
2. Abra o **Monitor Serial** da Arduino IDE (9600 baud). Aparecerão linhas assim:
   ```
   {"raw":35,"umidade":2,"estado":"seco"}
   ```
3. **Seco:** enterre as hastes num vaso com **terra seca** e anote o valor de `raw`
   (ex.: `20`). Dá também para medir com as hastes no ar, que resulta em cerca de 0.
4. **Molhado:** regue bem até a terra ficar encharcada, espere 1 minuto e anote o `raw`
   (ex.: `700`).
5. No topo do `.ino`, altere:
   ```cpp
   const int LEITURA_SECO    = 20;   // seu valor na terra seca
   const int LEITURA_MOLHADO = 700;  // seu valor na terra encharcada
   ```
6. Grave de novo. Se quiser, ajuste também `LEITURA_SECO` / `LEITURA_MOLHADO` em
   `servidor/app.py`. Lá eles são usados só no modo simulação.

> Calibre com a terra de verdade, não com um copo d'água. A água da torneira conduz de forma
> diferente da terra úmida e distorce a escala.

## Ajustando os limites de rega

Também no topo do `.ino` (e em `servidor/app.py`, para as faixas do gráfico):

| Constante | Padrão | Significado |
|---|---|---|
| `LIMITE_SECO` | 30 | Abaixo disso → **Precisa de água** (LED vermelho piscando) |
| `LIMITE_UMIDO` | 60 | A partir disso → **Solo úmido** (LED verde) |
| `HISTERESE` | 5 | Margem para o estado não ficar alternando perto de um limite |

Plantas de clima seco (cactos, suculentas) podem usar limites menores (ex.: 15 / 35).
Samambaias e plantas tropicais preferem limites maiores (ex.: 40 / 70).
