(() => {
  "use strict";

  const INTERVALO_ATUAL_MS = 2000;
  const INTERVALO_HISTORICO_MS = 15000;

  const ESTADOS = {
    seco: {
      titulo: "Precisa de água",
      descricao: "O solo está seco. Regue a planta agora.",
      icone: '<svg viewBox="0 0 24 24"><path d="M12 2.7C8.5 7 6 10.3 6 13.5a6 6 0 0 0 12 0c0-3.2-2.5-6.5-6-10.8z"/></svg>',
    },
    atencao: {
      titulo: "Atenção",
      descricao: "A umidade está baixando. Regue em breve.",
      icone: '<svg viewBox="0 0 24 24"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
    },
    umido: {
      titulo: "Solo úmido",
      descricao: "Tudo certo! A planta não precisa de água agora.",
      icone: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/></svg>',
    },
    offline: {
      titulo: "Sensor offline",
      descricao: "Nenhuma leitura recente. Verifique o cabo USB do Arduino e se o servidor está rodando.",
      icone: '<svg viewBox="0 0 24 24"><path d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5.2-2.8M19 12.9a10 10 0 0 0-2-1.5M1.4 9a16 16 0 0 1 4.3-2.7M22.6 9A16 16 0 0 0 11 5M12 20h.01"/></svg>',
    },
  };

  const $ = (id) => document.getElementById(id);
  const ARCO = 377; // 3/4 da circunferência (r = 80)

  let limites = { seco: 30, umido: 60 };
  let horas = 24;
  let grafico = null;

  // ------------------------------------------------------------ utilidades

  const fmtHora = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const fmtDiaHora = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const fmtData = new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit" });

  function pct(v) {
    return v == null ? "--" : `${Math.round(v)}%`;
  }

  function tempoRelativo(segundos) {
    if (segundos == null) return "—";
    if (segundos < 5) return "agora";
    if (segundos < 60) return `há ${Math.round(segundos)} s`;
    if (segundos < 3600) return `há ${Math.round(segundos / 60)} min`;
    if (segundos < 86400) return `há ${Math.round(segundos / 3600)} h`;
    return `há ${Math.round(segundos / 86400)} dias`;
  }

  function cor(nome) {
    return getComputedStyle(document.documentElement).getPropertyValue(nome).trim();
  }

  async function buscar(url) {
    const resposta = await fetch(url, { cache: "no-store" });
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
    return resposta.json();
  }

  // ------------------------------------------------------------ tema

  function temaInicial() {
    try {
      const salvo = localStorage.getItem("tema");
      if (salvo === "light" || salvo === "dark") return salvo;
    } catch (_) { /* armazenamento indisponível */ }
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function aplicarTema(tema) {
    document.documentElement.dataset.theme = tema;
    if (grafico) atualizarCoresGrafico();
  }

  $("tema").addEventListener("click", () => {
    const novo = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    aplicarTema(novo);
    try { localStorage.setItem("tema", novo); } catch (_) { /* ignora */ }
  });

  aplicarTema(temaInicial());

  // ------------------------------------------------------------ medidor

  function desenharMarcas() {
    const g = $("medidor-marcas");
    g.innerHTML = "";
    for (const valor of [limites.seco, limites.umido]) {
      // O SVG está rotacionado 135°, então o ângulo 0 aqui = início do arco.
      const ang = (valor / 100) * 270 * (Math.PI / 180);
      const [r1, r2] = [90, 97];
      const linha = document.createElementNS("http://www.w3.org/2000/svg", "line");
      linha.setAttribute("x1", 100 + r1 * Math.cos(ang));
      linha.setAttribute("y1", 100 + r1 * Math.sin(ang));
      linha.setAttribute("x2", 100 + r2 * Math.cos(ang));
      linha.setAttribute("y2", 100 + r2 * Math.sin(ang));
      g.appendChild(linha);
    }
    document.querySelectorAll("[data-limite]").forEach((el) => {
      el.textContent = limites[el.dataset.limite];
    });
    document.querySelector(".faixa-seco").style.flex = limites.seco;
    document.querySelector(".faixa-atencao").style.flex = limites.umido - limites.seco;
    document.querySelector(".faixa-umido").style.flex = 100 - limites.umido;
    document.querySelector(".escala-rotulos").style.gridTemplateColumns =
      `${limites.seco}fr ${limites.umido - limites.seco}fr ${100 - limites.umido}fr`;
  }

  function renderAtual(dados) {
    const { leitura, online, idade_s: idade, modo } = dados;
    const medidor = $("medidor");
    const chave = !leitura ? null : online ? leitura.estado : "offline";

    // Conexão
    const pilula = $("conexao");
    if (!leitura || !online) {
      pilula.dataset.status = "offline";
      $("conexao-texto").textContent = "Sensor offline";
    } else if (modo === "simulacao") {
      pilula.dataset.status = "simulacao";
      $("conexao-texto").textContent = "Simulação";
    } else {
      pilula.dataset.status = "online";
      $("conexao-texto").textContent = "Ao vivo";
    }
    $("modo").textContent = modo === "simulacao" ? "dados simulados" : "dados do Arduino via USB";

    if (!leitura) {
      medidor.dataset.estado = "vazio";
      $("estado-titulo").textContent = "Aguardando leitura…";
      return;
    }

    const umidade = leitura.umidade;
    medidor.dataset.estado = leitura.estado;
    medidor.dataset.offline = String(!online);
    medidor.setAttribute("aria-label", `Umidade do solo: ${umidade}%`);
    $("medidor-valor").style.strokeDasharray = `${(ARCO * umidade) / 100} 503`;
    $("valor-umidade").textContent = umidade;

    const info = ESTADOS[chave];
    const icone = $("estado-icone");
    icone.dataset.estado = online ? leitura.estado : "";
    icone.innerHTML = info.icone;
    if ($("estado-titulo").textContent !== info.titulo) $("estado-titulo").textContent = info.titulo;
    $("estado-descricao").textContent = info.descricao;

    const marcador = $("escala-marcador");
    marcador.style.left = `${umidade}%`;
    marcador.classList.add("visivel");

    $("atualizado").textContent = tempoRelativo(idade);
    $("valor-raw").textContent = leitura.raw;

    document.title = online ? `${umidade}% · ${info.titulo} · Minha Planta` : "Offline · Minha Planta";
  }

  async function atualizarAtual() {
    try {
      const dados = await buscar("/api/atual");
      const mudou = dados.limites.seco !== limites.seco || dados.limites.umido !== limites.umido;
      limites = dados.limites;
      if (mudou) { desenharMarcas(); grafico && grafico.update("none"); }
      renderAtual(dados);
    } catch (_) {
      $("conexao").dataset.status = "offline";
      $("conexao-texto").textContent = "Servidor inacessível";
    }
  }

  // ------------------------------------------------------------ gráfico

  // Faixas de fundo (seco / úmido) + linhas dos limites.
  const pluginZonas = {
    id: "zonas",
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: a, scales: { y } } = chart;
      const faixa = (de, ate, corFundo) => {
        const topo = y.getPixelForValue(ate);
        const base = y.getPixelForValue(de);
        ctx.fillStyle = corFundo;
        ctx.fillRect(a.left, topo, a.right - a.left, base - topo);
      };
      ctx.save();
      faixa(0, limites.seco, cor("--zona-seco"));
      faixa(limites.umido, 100, cor("--zona-umido"));
      ctx.restore();
    },
  };

  // Linha vertical que acompanha o ponteiro.
  const pluginMira = {
    id: "mira",
    afterDatasetsDraw(chart) {
      const ativo = chart.tooltip && chart.tooltip.getActiveElements();
      if (!ativo || !ativo.length) return;
      const { ctx, chartArea: a } = chart;
      const x = ativo[0].element.x;
      ctx.save();
      ctx.strokeStyle = cor("--eixo");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, a.top);
      ctx.lineTo(x, a.bottom);
      ctx.stroke();
      ctx.restore();
    },
  };

  function formatarEixoX(valor) {
    const data = new Date(valor);
    if (horas <= 24) return fmtHora.format(data);
    return fmtData.format(data);
  }

  // Marcas do eixo X em horários "redondos" (a cada 10 min, 1 h, 4 h ou 1 dia).
  const PASSOS_EIXO = { 1: 10 * 60e3, 6: 3600e3, 24: 4 * 3600e3, 168: 86400e3 };

  function marcasRedondas(eixo) {
    const passo = PASSOS_EIXO[horas] || 3600e3;
    const fuso = new Date().getTimezoneOffset() * 60e3; // alinha à meia-noite local
    const marcas = [];
    for (let t = Math.ceil((eixo.min - fuso) / passo) * passo + fuso; t <= eixo.max; t += passo) {
      marcas.push({ value: t });
    }
    eixo.ticks = marcas;
  }

  function criarGrafico() {
    const ctx = $("grafico").getContext("2d");
    grafico = new Chart(ctx, {
      type: "line",
      data: {
        datasets: [{
          label: "Umidade",
          data: [],
          borderWidth: 2,
          borderJoinStyle: "round",
          borderCapStyle: "round",
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBorderWidth: 2,
          fill: "origin",
          spanGaps: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 400 },
        interaction: { mode: "index", intersect: false },
        layout: { padding: { top: 4, right: 4 } },
        scales: {
          x: {
            type: "linear",
            border: { display: false },
            grid: { display: false },
            afterBuildTicks: marcasRedondas,
            ticks: { maxRotation: 0, autoSkip: true, callback: formatarEixoX, font: { size: 12 } },
          },
          y: {
            min: 0,
            max: 100,
            border: { display: false },
            ticks: { stepSize: 20, callback: (v) => `${v}%`, font: { size: 12 }, padding: 8 },
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            displayColors: false,
            padding: 10,
            cornerRadius: 8,
            borderWidth: 1,
            titleFont: { weight: "600", size: 12 },
            bodyFont: { size: 13 },
            callbacks: {
              title: (itens) => fmtDiaHora.format(new Date(itens[0].parsed.x)),
              label: (item) => {
                const p = item.raw;
                const faixa = p.min !== p.max ? `  (mín. ${p.min}% · máx. ${p.max}%)` : "";
                return `Umidade: ${Math.round(p.y)}%${faixa}`;
              },
            },
          },
        },
      },
      plugins: [pluginZonas, pluginMira],
    });
    atualizarCoresGrafico();
  }

  function atualizarCoresGrafico() {
    const serie = cor("--serie");
    const ds = grafico.data.datasets[0];
    const altura = $("grafico").clientHeight || 300;
    const gradiente = grafico.ctx.createLinearGradient(0, 0, 0, altura);
    gradiente.addColorStop(0, cor("--serie-lavagem"));
    gradiente.addColorStop(1, "rgba(0,0,0,0)");
    ds.borderColor = serie;
    ds.backgroundColor = gradiente;
    ds.pointHoverBackgroundColor = serie;
    ds.pointHoverBorderColor = cor("--superficie");

    const { x, y } = grafico.options.scales;
    x.ticks.color = y.ticks.color = cor("--texto-3");
    y.grid.color = cor("--grade");

    const tt = grafico.options.plugins.tooltip;
    tt.backgroundColor = cor("--superficie");
    tt.titleColor = cor("--texto-2");
    tt.bodyColor = cor("--texto");
    tt.borderColor = cor("--borda");
    grafico.update("none");
  }

  // Quebra a linha onde o sensor ficou sem enviar dados, em vez de ligar os pontos.
  function comLacunas(pontos, balde) {
    const saida = [];
    pontos.forEach((p, i) => {
      if (i > 0 && p.ts - pontos[i - 1].ts > balde * 3) {
        saida.push({ x: (pontos[i - 1].ts + balde) * 1000, y: null });
      }
      saida.push({ x: p.ts * 1000, y: p.umidade, min: p.minimo, max: p.maximo });
    });
    return saida;
  }

  function renderHistorico(dados) {
    const agora = Date.now();
    const ds = grafico.data.datasets[0];
    ds.data = comLacunas(dados.pontos, dados.balde_s);
    grafico.options.scales.x.min = agora - dados.horas * 3600 * 1000;
    grafico.options.scales.x.max = agora;
    grafico.update();
    $("grafico-vazio").hidden = dados.pontos.length > 0;

    const r = dados.resumo;
    $("stat-media").textContent = pct(r.media);
    $("stat-minimo").textContent = pct(r.minimo);
    $("stat-maximo").textContent = pct(r.maximo);
    $("stat-seco").textContent = r.leituras ? pct(r.pct_seco) : "--";

    const corpo = $("tabela-corpo");
    corpo.replaceChildren(...dados.pontos.slice().reverse().map((p) => {
      const tr = document.createElement("tr");
      const data = new Date(p.ts * 1000);
      [horas <= 24 ? fmtHora.format(data) : fmtDiaHora.format(data), pct(p.umidade), pct(p.minimo), pct(p.maximo)]
        .forEach((texto) => {
          const td = document.createElement("td");
          td.textContent = texto;
          tr.appendChild(td);
        });
      return tr;
    }));
  }

  async function atualizarHistorico() {
    try {
      renderHistorico(await buscar(`/api/historico?horas=${horas}`));
    } catch (_) { /* a pílula de conexão já sinaliza o erro */ }
  }

  const ROTULOS_PERIODO = { 1: "da última hora", 6: "das últimas 6 h", 24: "das últimas 24 h", 168: "dos últimos 7 dias" };

  document.querySelectorAll(".segmentado button").forEach((botao) => {
    botao.addEventListener("click", () => {
      document.querySelectorAll(".segmentado button").forEach((b) => b.removeAttribute("aria-pressed"));
      botao.setAttribute("aria-pressed", "true");
      horas = Number(botao.dataset.horas);
      $("resumo-periodo").textContent = ROTULOS_PERIODO[horas];
      atualizarHistorico();
    });
  });

  // Acompanha a troca de tema do sistema quando o usuário não escolheu um.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    let salvo = null;
    try { salvo = localStorage.getItem("tema"); } catch (_) { /* ignora */ }
    if (!salvo) aplicarTema(e.matches ? "dark" : "light");
  });

  // ------------------------------------------------------------ início

  desenharMarcas();
  criarGrafico();
  atualizarAtual();
  atualizarHistorico();
  setInterval(atualizarAtual, INTERVALO_ATUAL_MS);
  setInterval(atualizarHistorico, INTERVALO_HISTORICO_MS);
})();
