// SyncTeam — design preview (referência visual solta)
//
// Vanilla JS, sem build step, sem framework. Reimplementa em miniatura a
// MESMA lógica de decisão dos módulos reais (buildStatusVisual/buildMenuOptions
// de statusBarMenu.ts, os 3 estados de connectionStatus de PluginUI.luau, a
// prioridade INFO de PluginUI.buildSessionsMap, etc.) só pra fins de
// visualização — nenhum código daqui é importado pelo produto real, e
// nenhuma mudança aqui afeta plugin/ ou vscode-extension/.
//
// Organização: 1 bloco por "tela" da sidebar, cada um com seu próprio estado
// local + função de render + wiring de inputs "data-lab". Um helper genérico
// (onLab/bindMirror) cobre o padrão repetitivo de "campo de texto edita e
// atualiza ao vivo".

(function () {
  "use strict";

  // ---------------------------------------------------------- utilidades

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, "&quot;");
  }

  /** Liga um input/select/textarea `[data-lab="key"]` a um handler(valor). Roda 1x na carga pra garantir estado inicial consistente. */
  function onLab(key, handler) {
    var el = document.querySelector('[data-lab="' + key + '"]');
    if (!el) {
      return;
    }
    var fire = function () {
      handler(el.value);
    };
    el.addEventListener("input", fire);
    el.addEventListener("change", fire);
  }

  /** Espelha um campo de texto direto em todo elemento `[data-bind="key"]` — para os casos sem lógica extra (só troca de texto). */
  function bindMirror(key) {
    onLab(key, function (value) {
      var targets = document.querySelectorAll('[data-bind="' + key + '"]');
      for (var i = 0; i < targets.length; i++) {
        targets[i].textContent = value;
      }
    });
  }

  function hexToRgba(hex, alpha) {
    var v = hex.replace("#", "");
    var r = parseInt(v.substring(0, 2), 16);
    var g = parseInt(v.substring(2, 4), 16);
    var b = parseInt(v.substring(4, 6), 16);
    return "rgba(" + r + ", " + g + ", " + b + ", " + alpha + ")";
  }

  // -------------------------------------------------------- navegação (sidebar)

  var navItems = Array.prototype.slice.call(document.querySelectorAll(".nav-item"));
  function activateScreen(targetId) {
    var screens = document.querySelectorAll(".screen");
    for (var i = 0; i < screens.length; i++) {
      screens[i].classList.toggle("is-active", screens[i].id === targetId);
    }
    navItems.forEach(function (btn) {
      btn.classList.toggle("is-active", btn.dataset.target === targetId);
    });
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  navItems.forEach(function (btn) {
    btn.addEventListener("click", function () {
      activateScreen(btn.dataset.target);
    });
  });

  // ==================================================================
  // STUDIO — Painel principal (MainView, StatusPanel.luau/PluginUI.luau)
  // ==================================================================

  var mainState = {
    port: 1400, // Config.DEFAULT_PORT
    connStatus: "disconnected", // "disconnected" | "connecting" | "connected"
    infoColor: "neutro", // "neutro" | "sucesso" | "aviso" | "erro" — cor da linha INFO (briefing "Modux Companion")
    labels: {
      disconnected: "CONNECT",
      connecting: "CONECTANDO...",
      connected: "DISCONNECT",
    },
    rows: [
      { username: "você (Ana)", info: "editando PlayerController.server.luau", isLeader: true },
      { username: "Bruno", info: "vendo Inventory.module.luau", isLeader: false },
      { username: "Carla", info: "ocioso", isLeader: false },
    ],
  };

  function renderMainTableOnly() {
    var table = document.getElementById("main-sessions-table");
    table.innerHTML = mainState.rows
      .map(function (row) {
        return (
          '<div class="st-row' +
          (row.isLeader ? " is-leader" : "") +
          '">' +
          '<span class="st-row__dot"></span>' +
          '<span class="st-row__user">' +
          escapeHtml(row.username) +
          "</span>" +
          '<span class="st-row__info">' +
          escapeHtml(row.info) +
          "</span>" +
          "</div>"
        );
      })
      .join("");
  }

  function renderMainRowsEditor() {
    var container = document.getElementById("main-rows-editor");
    container.innerHTML =
      mainState.rows
        .map(function (row, i) {
          return (
            '<div class="lab__row">' +
            '<input type="radio" name="main-leader-radio" title="líder" data-row-leader="' +
            i +
            '" ' +
            (row.isLeader ? "checked" : "") +
            " />" +
            '<input type="text" data-row-field="username" data-row-index="' +
            i +
            '" value="' +
            escapeAttr(row.username) +
            '" placeholder="usuário" />' +
            '<input type="text" data-row-field="info" data-row-index="' +
            i +
            '" value="' +
            escapeAttr(row.info) +
            '" placeholder="info" />' +
            '<button type="button" class="lab__action-btn" style="padding:4px 8px;font-size:11px;" data-row-remove="' +
            i +
            '">remover</button>' +
            "</div>"
          );
        })
        .join("") +
      '<button type="button" id="main-row-add" class="lab__action-btn" style="margin-top:2px;">+ adicionar sessão</button>';

    Array.prototype.forEach.call(container.querySelectorAll("[data-row-field]"), function (input) {
      input.addEventListener("input", function () {
        var idx = Number(input.dataset.rowIndex);
        mainState.rows[idx][input.dataset.rowField] = input.value;
        renderMainTableOnly();
      });
    });
    Array.prototype.forEach.call(container.querySelectorAll("[data-row-leader]"), function (radio) {
      radio.addEventListener("change", function () {
        var idx = Number(radio.dataset.rowLeader);
        mainState.rows.forEach(function (r, i) {
          r.isLeader = i === idx;
        });
        renderMainTableOnly();
      });
    });
    Array.prototype.forEach.call(container.querySelectorAll("[data-row-remove]"), function (btn) {
      btn.addEventListener("click", function () {
        mainState.rows.splice(Number(btn.dataset.rowRemove), 1);
        renderMainRowsEditor();
        renderMainTableOnly();
      });
    });
    var addBtn = document.getElementById("main-row-add");
    if (addBtn) {
      addBtn.addEventListener("click", function () {
        mainState.rows.push({ username: "Novo colaborador", info: "ocioso", isLeader: false });
        renderMainRowsEditor();
        renderMainTableOnly();
      });
    }
  }

  var connectBtn = document.getElementById("main-connect-btn");
  var mainStatusSquare = document.getElementById("main-status-square");
  function renderConnectButton() {
    connectBtn.dataset.state = mainState.connStatus;
    connectBtn.textContent = mainState.labels[mainState.connStatus];
    // Indicador de status (quadrado na titlebar, briefing "Modux
    // Companion") segue o MESMO estado do botão CONNECT — mas pode usar
    // cores diferentes (ver CSS .st-status-square): o quadrado lê "saúde
    // da conexão" (cinza/amarelo/verde), o botão lê "ação disponível"
    // (verde/amarelo/vermelho) — ver .claude/agent-memory/ui-dev.md.
    if (mainStatusSquare) {
      mainStatusSquare.dataset.state = mainState.connStatus;
    }
  }
  connectBtn.addEventListener("click", function () {
    var order = ["disconnected", "connecting", "connected"];
    var next = order[(order.indexOf(mainState.connStatus) + 1) % order.length];
    mainState.connStatus = next;
    renderConnectButton();
    var select = document.querySelector('[data-lab="main.connStatus"]');
    if (select) {
      select.value = next;
    }
  });

  var portBox = document.getElementById("main-port-box");
  function commitPortBox() {
    var parsed = parseInt(portBox.value, 10);
    if (!isNaN(parsed) && parsed > 0) {
      mainState.port = Math.floor(parsed);
    }
    portBox.value = String(mainState.port);
    var labInput = document.querySelector('[data-lab="main.port"]');
    if (labInput) {
      labInput.value = String(mainState.port);
    }
  }
  portBox.addEventListener("blur", commitPortBox);
  portBox.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      portBox.blur();
    }
  });

  document.getElementById("main-gear-btn").addEventListener("click", function () {
    activateScreen("screen-studio-settings");
  });

  // Botão "RESYNC" — MOCKUP, feature ainda não implementada no produto real
  // (limpar Source local e repuxar do Studio; ver descrição no painel lab).
  // Demonstração pedida pelo usuário: reaproveita o MESMO mecanismo de
  // atributo que .st-connect-btn já usa (data-state) pra ciclar
  // RESYNC (cinza) -> SYNCING.... (amarelo, ~1.2s) -> DONE (verde, ~1.2s) ->
  // volta pra RESYNC. Token de geração (mesmo idioma do toast acima) evita
  // que um clique duplo durante o ciclo deixe dois setTimeout brigando pelo
  // estado final — desabilitar o botão durante o ciclo já evita o duplo
  // clique na prática, o token é só defesa extra.
  var resyncBtn = document.getElementById("main-resync-btn");
  var resyncToken = 0;
  var RESYNC_STATE_MS = 1200;

  // Espelha a cor escolhida também no <select> do painel lab, mesmo padrão
  // já usado por outros ciclos automáticos (ex.: main.connStatus acima).
  function setMainInfoColorAndSyncLab(color) {
    applyMainInfoColor(color);
    var lab = document.querySelector('[data-lab="main.infoColor"]');
    if (lab) {
      lab.value = color;
    }
  }

  function setResyncState(state) {
    if (state === "syncing") {
      resyncBtn.dataset.state = "syncing";
      resyncBtn.textContent = "SYNCING....";
      resyncBtn.disabled = true;
      setMainInfoColorAndSyncLab("aviso");
    } else if (state === "done") {
      resyncBtn.dataset.state = "done";
      resyncBtn.textContent = "DONE";
      resyncBtn.disabled = true;
      setMainInfoColorAndSyncLab("sucesso");
    } else {
      delete resyncBtn.dataset.state;
      resyncBtn.textContent = "RESYNC";
      resyncBtn.disabled = false;
      setMainInfoColorAndSyncLab("neutro");
    }
  }

  resyncBtn.addEventListener("click", function () {
    resyncToken++;
    var myToken = resyncToken;

    var demoText = "ReSync: fontes recarregadas.";
    applyMainInfoText(demoText);
    applyMainInfoSeconds(0);
    var textLab = document.querySelector('[data-lab="main.infoText"]');
    if (textLab) {
      textLab.value = demoText;
    }
    var secLab = document.querySelector('[data-lab="main.infoSeconds"]');
    if (secLab) {
      secLab.value = "0";
    }

    setResyncState("syncing");
    setTimeout(function () {
      if (resyncToken !== myToken) {
        return; // um clique mais novo já assumiu o ciclo
      }
      setResyncState("done");
      setTimeout(function () {
        if (resyncToken !== myToken) {
          return;
        }
        setResyncState("idle");
      }, RESYNC_STATE_MS);
    }, RESYNC_STATE_MS);
  });

  // Linha INFO (2026-08-02: virou label + campo tipo .st-textbox, igual à
  // linha Porta, em vez de texto solto) — o campo é readonly, só reflete o
  // último log (mesmo papel de PluginUI.infoTextSource/infoElapsedSecondsSource
  // no plugin real); os segundos viram um selo separado, não concatenados
  // no texto. Funções extraídas (não só onLab inline) porque o botão
  // ReSync abaixo precisa escrever nos MESMOS elementos.
  function applyMainInfoText(text) {
    document.getElementById("main-info-box").value = text;
  }
  function applyMainInfoSeconds(seconds) {
    document.getElementById("main-info-seconds").textContent = seconds + "s atrás";
  }
  // Cor da linha INFO conforme o estado da última mensagem (briefing
  // "Modux Companion") — ver .st-inforow/#main-info-box[data-color] no CSS.
  function applyMainInfoColor(color) {
    mainState.infoColor = color;
    document.getElementById("main-info-box").dataset.color = color;
  }
  onLab("main.infoText", applyMainInfoText);
  onLab("main.infoSeconds", applyMainInfoSeconds);
  onLab("main.infoColor", applyMainInfoColor);

  onLab("main.title", function () {}); // mirror cuidado abaixo via bindMirror
  onLab("main.connStatus", function (v) {
    mainState.connStatus = v;
    renderConnectButton();
  });
  onLab("main.port", function (v) {
    var n = parseInt(v, 10);
    if (!isNaN(n) && n > 0) {
      mainState.port = n;
      portBox.value = String(n);
    }
  });
  onLab("main.labelDisconnected", function (v) {
    mainState.labels.disconnected = v;
    renderConnectButton();
  });
  onLab("main.labelConnecting", function (v) {
    mainState.labels.connecting = v;
    renderConnectButton();
  });
  onLab("main.labelConnected", function (v) {
    mainState.labels.connected = v;
    renderConnectButton();
  });

  // ==================================================================
  // STUDIO — Configurações (SettingsView)
  // ==================================================================

  document.querySelector(".st-back-btn").addEventListener("click", function () {
    activateScreen("screen-studio-main");
  });

  function wireToggleButton(id, initialOn) {
    var btn = document.getElementById(id);
    if (!btn) return;
    btn.textContent = initialOn ? "Ativado" : "Desativado";
    btn.addEventListener("click", function () {
      var on = btn.textContent.trim() === "Ativado";
      btn.textContent = on ? "Desativado" : "Ativado";
    });
  }
  wireToggleButton("settings-notif-toggle", true);
  wireToggleButton("settings-auto-toggle", false);

  // ==================================================================
  // STUDIO — Toast (notificação flutuante em CoreGui)
  // ==================================================================

  var toastEl = document.getElementById("studio-toast");
  var toastTitlebar = document.getElementById("studio-toast-titlebar");
  var toastToken = 0;
  var toastHideTimer = null;
  var toastCleanupTimer = null;

  // Reskin 2026-08-02 (6ª rodada, briefing "Modux Companion"): a cor por
  // severidade agora vive inteiramente no CSS
  // (.st-toast__titlebar[data-severity]) — o JS só seta o atributo, o que
  // permite o CSS decidir TAMBÉM a cor do texto (branco em sucesso/aviso/
  // erro, preto no fallback "info"), coisa que um style.background solto
  // no JS não conseguiria fazer sozinho.
  var toastSeverity = "aviso";
  function applyToastSeverityColor() {
    toastTitlebar.dataset.severity = toastSeverity;
  }
  onLab("toast.severity", function (v) {
    toastSeverity = v;
    applyToastSeverityColor();
  });

  function showToast() {
    toastToken++;
    var myToken = toastToken;
    clearTimeout(toastHideTimer);
    clearTimeout(toastCleanupTimer);
    toastEl.classList.remove("is-leaving");
    // força reflow antes de reaplicar is-visible, pra reiniciar a transição
    // caso o toast já estivesse no meio de uma animação de saída.
    void toastEl.offsetWidth;
    toastEl.classList.add("is-visible");
    toastHideTimer = setTimeout(function () {
      if (toastToken !== myToken) {
        return; // um show()/dismiss() mais novo já assumiu
      }
      dismissToast();
    }, 5000); // Toast.luau: HOLD_SECONDS
  }
  function dismissToast() {
    toastToken++;
    toastEl.classList.add("is-leaving");
    toastEl.classList.remove("is-visible");
    clearTimeout(toastCleanupTimer);
    toastCleanupTimer = setTimeout(function () {
      toastEl.classList.remove("is-leaving");
    }, 300);
  }
  document.getElementById("toast-show-btn").addEventListener("click", showToast);
  toastEl.querySelector(".st-toast__close").addEventListener("click", dismissToast);

  // ==================================================================
  // VS CODE — Barra de status + menu (statusBarMenu.ts/StatusBarItem.ts)
  // ==================================================================

  var sb = {
    appName: "SyncTeam",
    port: 1400,
    state: "waiting", // "stopped" | "waiting" | "connected"
    labels: {
      start: "$(play) Iniciar",
      stop: "$(debug-stop) Parar",
      setPort: "$(plug) Trocar porta",
      refresh: "$(sync) Refresh Sync",
      showOutput: "$(output) Mostrar log",
    },
  };

  function statusIconSvg(kind) {
    if (kind === "stopped") {
      return '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/>';
    }
    if (kind === "connected") {
      return '<circle cx="8" cy="8" r="6" fill="currentColor"/>';
    }
    // "waiting" -> broadcast (ponto + 2 arcos), mesmo espírito do codicon $(broadcast)
    return (
      '<circle cx="8" cy="8" r="1.6" fill="currentColor"/>' +
      '<path d="M5.2 5.2a4 4 0 0 0 0 5.6" stroke="currentColor" stroke-width="1.3" fill="none"/>' +
      '<path d="M10.8 5.2a4 4 0 0 1 0 5.6" stroke="currentColor" stroke-width="1.3" fill="none"/>'
    );
  }

  function renderStatusBar() {
    var item = document.getElementById("vsc-syncteam-item");
    var icon = document.getElementById("vsc-syncteam-icon");
    var text = document.getElementById("vsc-syncteam-text");
    var kind, tooltip;

    if (sb.state === "stopped") {
      kind = "stopped";
      tooltip = sb.appName + " parado (porta " + sb.port + "). Clique para ver as opções.";
    } else if (sb.state === "waiting") {
      kind = "waiting";
      tooltip = sb.appName + " no ar na porta " + sb.port + ", aguardando o plugin do Studio conectar. Clique para ver as opções.";
    } else {
      kind = "connected";
      tooltip = sb.appName + " conectado ao plugin do Studio (porta " + sb.port + "). Clique para ver as opções.";
    }

    icon.innerHTML = statusIconSvg(kind);
    icon.style.color = "#ffffff";
    text.textContent = sb.appName + " :" + sb.port;
    item.title = tooltip;
    item.classList.toggle("vsc-statusitem--warning", sb.state === "waiting");
  }

  function renderQuickpickOptions() {
    var list = document.getElementById("vsc-quickpick-list");
    var opts = [];
    if (sb.state === "stopped") {
      opts.push({ label: sb.labels.start, detail: "Sobe o servidor local e passa a aceitar o plugin do Studio" });
    } else {
      opts.push({ label: sb.labels.stop, detail: "Encerra o servidor local e desconecta o plugin do Studio" });
    }
    opts.push({ label: sb.labels.setPort, detail: "Escolhe a porta local usada para conectar o plugin do Studio" });
    if (sb.state === "connected") {
      opts.push({ label: sb.labels.refresh, detail: "Reconcilia disco e Studio agora (pega edições feitas com a extensão fechada)" });
    }
    opts.push({ label: sb.labels.showOutput, detail: "Abre o canal de saída do SyncTeam" });

    list.innerHTML = opts
      .map(function (o) {
        return (
          '<div class="vsc-quickpick__item">' +
          '<div class="vsc-quickpick__item-label">' +
          escapeHtml(o.label) +
          "</div>" +
          '<div class="vsc-quickpick__item-detail">' +
          escapeHtml(o.detail) +
          "</div>" +
          "</div>"
        );
      })
      .join("");
    Array.prototype.forEach.call(list.querySelectorAll(".vsc-quickpick__item"), function (el) {
      el.addEventListener("click", function () {
        setQuickpickVisible(false);
      });
    });
  }

  function setQuickpickVisible(visible) {
    document.getElementById("vsc-quickpick").hidden = !visible;
  }

  document.getElementById("vsc-syncteam-item").addEventListener("click", function (e) {
    e.stopPropagation();
    renderQuickpickOptions();
    setQuickpickVisible(document.getElementById("vsc-quickpick").hidden);
  });
  document.addEventListener("click", function () {
    setQuickpickVisible(false);
  });

  onLab("statusbar.state", function (v) {
    sb.state = v;
    renderStatusBar();
  });
  onLab("statusbar.port", function (v) {
    var n = parseInt(v, 10);
    sb.port = isNaN(n) ? sb.port : n;
    renderStatusBar();
  });
  onLab("statusbar.appName", function (v) {
    sb.appName = v || "SyncTeam";
    renderStatusBar();
  });
  onLab("statusbar.menuStart", function (v) {
    sb.labels.start = v;
  });
  onLab("statusbar.menuStop", function (v) {
    sb.labels.stop = v;
  });
  onLab("statusbar.menuSetPort", function (v) {
    sb.labels.setPort = v;
  });
  onLab("statusbar.menuRefresh", function (v) {
    sb.labels.refresh = v;
  });
  onLab("statusbar.menuShowOutput", function (v) {
    sb.labels.showOutput = v;
  });

  // ==================================================================
  // VS CODE — Aviso de lease alheia (LeaseBorderDecoration.ts)
  // ==================================================================

  var lease = {
    locked: true,
    owner: "Ana",
    labelTemplate: "🔒 Bloqueado por {owner}", // 🔒
    hoverTemplate:
      "SyncTeam: este arquivo está sob edição de {owner}. Suas alterações locais não serão sincronizadas enquanto a lease não for liberada (inatividade do outro lado) — edite com cuidado.",
    saveWarningTemplate:
      "SyncTeam: '{file}' está bloqueado para edição por {owner} — o Studio vai rejeitar esta alteração quando ela chegar lá.",
  };

  function fillTemplate(tpl, owner) {
    return tpl.split("{owner}").join(owner).split("{file}").join("Inventory.module.luau");
  }

  function renderLease() {
    var ruler = document.getElementById("lease-ruler");
    var label = document.getElementById("lease-inline-label");
    var codeBlock = document.getElementById("lease-code-block");
    var sbItem = document.getElementById("lease-statusbar-item");
    var sbText = document.getElementById("lease-statusbar-text");
    var owner = lease.owner || "outro colaborador";

    ruler.classList.toggle("is-locked", lease.locked);
    var hoverMsg = fillTemplate(lease.hoverTemplate, owner);
    ruler.title = lease.locked ? hoverMsg : "";
    codeBlock.title = lease.locked ? hoverMsg : "";

    if (lease.locked) {
      label.hidden = false;
      label.textContent = " " + fillTemplate(lease.labelTemplate, owner);
      sbText.textContent = owner;
      sbItem.title =
        "SyncTeam: '" + owner + "' tem a lease deste arquivo — suas edições locais não serão sincronizadas até ele liberar (por inatividade ou ao trocar de arquivo).";
      sbItem.style.display = "";
    } else {
      label.hidden = true;
      sbItem.style.display = "none";
    }
  }

  document.getElementById("lease-save-btn").addEventListener("click", function () {
    if (!lease.locked) {
      window.alert("Arquivo livre — nada seria bloqueado ao salvar.");
      return;
    }
    window.alert(fillTemplate(lease.saveWarningTemplate, lease.owner || "outro colaborador"));
  });

  onLab("lease.locked", function (v) {
    lease.locked = v === "true";
    renderLease();
  });
  onLab("lease.owner", function (v) {
    lease.owner = v;
    renderLease();
  });
  onLab("lease.label", function (v) {
    lease.labelTemplate = v;
    renderLease();
  });
  onLab("lease.hover", function (v) {
    lease.hoverTemplate = v;
    renderLease();
  });
  onLab("lease.saveWarning", function (v) {
    lease.saveWarningTemplate = v;
  });

  // ==================================================================
  // VS CODE — Cursor remoto (RemoteCursorDecorations.ts)
  // ==================================================================

  var COLLABORATOR_COLORS = ["#4287f5", "#ea4335", "#34a853", "#fbbc04", "#ab47bc", "#00acc1", "#ff7043", "#8d6e63"];

  var cursor = {
    name: "Bruno",
    colorIndex: 0,
    showSelection: true,
    blink: true,
  };

  function buildHoverBadgeHtml(name, color) {
    return '<span class="st-tooltip__badge" style="background:' + color + '">' + escapeHtml(name) + "</span>";
  }

  function renderCursor() {
    var caret = document.getElementById("cursor-caret-el");
    var selSpan = document.getElementById("cursor-selection-span");
    var color = COLLABORATOR_COLORS[cursor.colorIndex % COLLABORATOR_COLORS.length];

    caret.style.borderLeftColor = color;
    caret.classList.toggle("is-blinking", cursor.blink);
    caret.dataset.tooltipHtml = buildHoverBadgeHtml(cursor.name || "colaborador", color);
    selSpan.style.background = cursor.showSelection ? hexToRgba(color, 0.25) : "transparent";
  }

  (function wireCursorHover() {
    var caret = document.getElementById("cursor-caret-el");
    var tooltip = document.getElementById("st-shared-tooltip");
    caret.addEventListener("mouseenter", function (e) {
      tooltip.innerHTML = caret.dataset.tooltipHtml || "";
      tooltip.classList.add("is-visible");
      positionTooltip(e);
    });
    caret.addEventListener("mousemove", positionTooltip);
    caret.addEventListener("mouseleave", function () {
      tooltip.classList.remove("is-visible");
    });
    function positionTooltip(e) {
      tooltip.style.left = e.clientX + 14 + "px";
      tooltip.style.top = e.clientY + 16 + "px";
    }
  })();

  onLab("cursor.name", function (v) {
    cursor.name = v;
    renderCursor();
  });
  onLab("cursor.colorIndex", function (v) {
    cursor.colorIndex = Number(v) || 0;
    renderCursor();
  });
  onLab("cursor.showSelection", function (v) {
    cursor.showSelection = v === "true";
    renderCursor();
  });
  onLab("cursor.blink", function (v) {
    cursor.blink = v === "true";
    renderCursor();
  });

  // ==================================================================
  // VS CODE — Presença no Explorer (FilePresenceDecorations.ts)
  // ==================================================================

  var CHARTS_COLORS = ["#3794ff", "#f14c4c", "#89d185", "#cca700", "#b180d7", "#e7e7e7", "#d18616", "#8a8a8a"];

  var presenceFiles = [
    { name: "PlayerController.server.luau", collaboratorsText: "Ana" },
    { name: "Inventory.module.luau", collaboratorsText: "" },
    { name: "Shop.client.luau", collaboratorsText: "Bruno, Carla" },
  ];

  function renderPresenceTree() {
    var tree = document.getElementById("presence-tree");
    var folderHeader = tree.querySelector(".vsc-tree__folder");
    tree.innerHTML = "";
    if (folderHeader) {
      tree.appendChild(folderHeader);
    }
    presenceFiles.forEach(function (file, idx) {
      var names = file.collaboratorsText
        .split(",")
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean);

      var row = document.createElement("div");
      row.className = "vsc-tree__file";

      var icon = document.createElement("span");
      icon.textContent = "📄"; // 📄
      row.appendChild(icon);

      var label = document.createElement("span");
      label.textContent = file.name;
      row.appendChild(label);

      if (names.length > 0) {
        var badge = document.createElement("span");
        badge.className = "vsc-tree__file-badge";
        badge.textContent = "●"; // ●
        badge.style.color = CHARTS_COLORS[idx % CHARTS_COLORS.length];
        badge.title = "SyncTeam: sendo editado por " + names.join(", ");
        row.appendChild(badge);
      }

      tree.appendChild(row);
    });
  }

  function renderPresenceEditor() {
    var container = document.getElementById("presence-rows-editor");
    container.innerHTML = presenceFiles
      .map(function (file, i) {
        return (
          '<div class="lab__row" style="grid-template-columns:1fr 1fr;">' +
          '<label style="font-size:11px;color:var(--tool-text-muted);display:flex;flex-direction:column;gap:2px;">Arquivo' +
          '<input type="text" data-presence-field="name" data-presence-index="' +
          i +
          '" value="' +
          escapeAttr(file.name) +
          '" /></label>' +
          '<label style="font-size:11px;color:var(--tool-text-muted);display:flex;flex-direction:column;gap:2px;">Colaboradores (vírgula)' +
          '<input type="text" data-presence-field="collaboratorsText" data-presence-index="' +
          i +
          '" value="' +
          escapeAttr(file.collaboratorsText) +
          '" placeholder="ex.: Ana, Bruno" /></label>' +
          "</div>"
        );
      })
      .join("");

    Array.prototype.forEach.call(container.querySelectorAll("[data-presence-field]"), function (input) {
      input.addEventListener("input", function () {
        var idx = Number(input.dataset.presenceIndex);
        presenceFiles[idx][input.dataset.presenceField] = input.value;
        renderPresenceTree();
      });
    });
  }

  // ==================================================================
  // inicialização
  // ==================================================================

  [
    "main.title",
    // "main.infoText"/"main.infoSeconds" NÃO usam bindMirror — a linha INFO
    // virou um <input readonly> (precisa de .value, não .textContent) mais
    // um selo separado pros segundos; ver applyMainInfoText/applyMainInfoSeconds
    // acima, ligados via onLab direto.
    "main.colUser",
    "main.colInfo",
    "settings.title",
    "settings.notifLabel",
    "settings.autoLabel",
    "settings.disabled1",
    "settings.disabled2",
    "settings.disabled3",
    "settings.soonText",
    "toast.text",
  ].forEach(bindMirror);

  renderMainTableOnly();
  renderMainRowsEditor();
  renderConnectButton();
  applyToastSeverityColor();
  renderStatusBar();
  renderLease();
  renderCursor();
  renderPresenceTree();
  renderPresenceEditor();

  activateScreen("screen-studio-main");
})();
