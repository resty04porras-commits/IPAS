/* IPAS login scenery only. Authentication and application views stay with React. */
(function () {
  "use strict";

  var root = document.getElementById("root");
  if (!root) return;

  var current = null;
  var queued = false;
  var scene = null;
  var motionButton = null;
  var userPaused = null;
  var atmosphere = null;
  var atmosphereKind = null;
  var seasonTimer = null;
  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var SEASONS = {
    newyear_eve: { palette: "slate", scene: "christmas", effect: "fireworks" },
    newyear: { palette: "slate", scene: "christmas", effect: "fireworks" },
    dinagyang: { palette: "copper", scene: "festival", effect: "ambient" },
    valentine: { palette: "plum", scene: "rose", effect: "ambient" },
    holyweek: { palette: "plum", scene: "reflection", effect: "candles" },
    summer: { palette: "warm", scene: "sunset", effect: "ambient" },
    rainy: { palette: "rain", scene: "rain", effect: "rain" },
    ber_months: { palette: "evergreen", scene: "christmas", effect: "lights" },
    halloween_season: { palette: "halloween", scene: "halloween", effect: "fog" },
    halloween: { palette: "halloween", scene: "halloween", effect: "fog" },
    undas: { palette: "plum", scene: "reflection", effect: "candles" },
    christmas_prep: { palette: "evergreen", scene: "christmas", effect: "lights" },
    christmas: { palette: "evergreen", scene: "christmas", effect: "lights" },
  };

  function getEaster(year) {
    var a = year % 19, b = Math.floor(year / 100), c = year % 100;
    var d = Math.floor(b / 4), e = b % 4;
    var f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    var h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
    var l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    var month = Math.floor((h + l - 7 * m + 114) / 31);
    var day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(year, month - 1, day);
  }

  function seasonForDate(date) {
    // Preserve the original 13-mode calendar and its rule priority/fallback.
    var year = date.getFullYear();
    var month = date.getMonth() + 1;
    var day = date.getDate();
    var dayOfYear = Math.floor((date - new Date(year, 0, 0)) / 86400000);
    var easterDay = Math.floor((getEaster(year) - new Date(year, 0, 0)) / 86400000);
    if (month === 12 && day === 31) return "newyear_eve";
    if (month === 1 && day <= 15) return "newyear";
    if (month === 1 && day >= 16) return "dinagyang";
    if (month === 2 && day <= 14) return "valentine";
    if (dayOfYear >= easterDay - 3 && dayOfYear <= easterDay) return "holyweek";
    if ((month === 3 && day >= 15) || month === 4 || month === 5) return "summer";
    if (month >= 6 && month <= 8) return "rainy";
    if (month === 9) return "ber_months";
    if (month === 10 && day === 31) return "halloween";
    if (month === 10) return "halloween_season";
    if (month === 11 && day <= 2) return "undas";
    if (month === 11) return "christmas_prep";
    if (month === 12) return "christmas";
    return "christmas";
  }

  function scheduleSeasonCheck() {
    if (seasonTimer !== null) return;
    var now = new Date();
    var nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
    seasonTimer = setTimeout(function () {
      seasonTimer = null;
      if (!document.hidden) queueSync();
    }, Math.max(1000, nextDay - now));
  }

  function findLogin() {
    // A password field in Settings or a password-change dialog is not the login.
    if (root.querySelector("aside")) return null;
    var employeeId = root.querySelector('input[placeholder="e.g. 2015-3357"]');
    if (!employeeId) return null;
    var card = employeeId.closest(".max-w-md");
    if (!card || !card.querySelector('input[type="password"]')) return null;
    var heading = card.querySelector("h1");
    if (!heading || heading.textContent.trim() !== "IICTD Process Automation System (IPAS)") return null;
    var signIn = Array.prototype.find.call(card.querySelectorAll("button"), function (button) {
      return button.textContent.trim() === "Sign In";
    });
    var surface = card.parentElement;
    if (!signIn || !surface || !surface.classList.contains("min-h-screen")) return null;
    return { surface: surface, card: card, button: signIn };
  }

  function syncMotion() {
    if (!current || !motionButton) return;
    var paused = document.hidden || (userPaused === null ? reducedMotion.matches : userPaused);
    current.surface.setAttribute("data-ipas-login-motion", paused ? "paused" : "playing");
    var label = paused ? "Play background" : "Pause background";
    if (motionButton.textContent !== label) motionButton.textContent = label;
    motionButton.setAttribute("aria-pressed", String(paused));
    if (atmosphere) atmosphere.setPlaying(!paused);
  }

  function createAtmosphere(surface, parent, kind) {
    var canvas = document.createElement("canvas");
    canvas.className = "ipas-login-atmosphere";
    parent.appendChild(canvas);
    var context = canvas.getContext("2d");
    if (!context) return { setPlaying: function () {}, dispose: function () { canvas.remove(); } };
    if (kind === "fog") parent.setAttribute("data-ipas-login-fog", "canvas");

    // Small precomputed coherent-noise sprites give the drifting mist texture.
    // Only scaled bitmap draws happen during playback; no full-screen pixel loop.
    function texture(dark) {
      var image = document.createElement("canvas");
      image.width = 256;
      image.height = 128;
      var imageContext = image.getContext("2d");
      var pixels = imageContext.createImageData(image.width, image.height);
      var grids = [8, 16, 32].map(function (size) {
        var values = [];
        for (var i = 0; i < (size + 1) * (size + 1); i++) values.push(Math.random());
        return { size: size, values: values };
      });
      function noise(grid, x, y) {
        var px = x * grid.size;
        var py = y * grid.size;
        var ix = Math.floor(px);
        var iy = Math.floor(py);
        var fx = px - ix;
        var fy = py - iy;
        fx = fx * fx * (3 - 2 * fx);
        fy = fy * fy * (3 - 2 * fy);
        var row = grid.size + 1;
        var top = grid.values[iy * row + ix] * (1 - fx) + grid.values[iy * row + ix + 1] * fx;
        var bottom = grid.values[(iy + 1) * row + ix] * (1 - fx) + grid.values[(iy + 1) * row + ix + 1] * fx;
        return top * (1 - fy) + bottom * fy;
      }
      for (var y = 0; y < image.height; y++) {
        for (var x = 0; x < image.width; x++) {
          var nx = (x + 0.5) / image.width;
          var ny = (y + 0.5) / image.height;
          var value = noise(grids[0], nx, ny) * 0.6 + noise(grids[1], nx, ny) * 0.28 + noise(grids[2], nx, ny) * 0.12;
          var fade = Math.pow(Math.sin(nx * Math.PI), 0.8) * Math.pow(Math.sin(ny * Math.PI), 0.85);
          var offset = (y * image.width + x) * 4;
          pixels.data[offset] = dark ? 31 : 173;
          pixels.data[offset + 1] = dark ? 43 : 191;
          pixels.data[offset + 2] = dark ? 59 : 203;
          pixels.data[offset + 3] = Math.max(0, Math.min(1, (value - 0.24) * 2.3)) * fade * 255;
        }
      }
      imageContext.putImageData(pixels, 0, 0);
      return image;
    }
    var mist = kind === "fog" ? texture(false) : null;
    var cloud = kind === "fog" ? texture(true) : null;
    var glow = document.createElement("canvas");
    glow.width = glow.height = 64;
    var glowContext = glow.getContext("2d");
    var gradient = glowContext.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, "rgba(255,248,221,0.8)");
    gradient.addColorStop(0.15, "rgba(255,220,145,0.5)");
    gradient.addColorStop(0.5, "rgba(239,176,79,0.12)");
    gradient.addColorStop(1, "rgba(239,176,79,0)");
    glowContext.fillStyle = gradient;
    glowContext.fillRect(0, 0, 64, 64);
    var lights = [];
    for (var light = 0; light < 24; light++) {
      lights.push({ x: light % 2 ? 0.8 + Math.random() * 0.18 : 0.02 + Math.random() * 0.22,
        y: 0.08 + Math.random() * 0.8, radius: 10 + Math.random() * 18, phase: Math.random() * Math.PI * 2 });
    }
    var frame = null;
    var playing = false;
    var elapsed = 0;
    var previous = null;
    var lastDraw = 0;

    function resize() {
      var width = Math.max(1, surface.clientWidth);
      var height = Math.max(1, surface.clientHeight);
      canvas.width = Math.min(960, width);
      canvas.height = Math.max(1, Math.round(canvas.width * height / width));
      draw();
    }
    function draw() {
      var w = canvas.width;
      var h = canvas.height;
      context.clearRect(0, 0, w, h);
      if (kind === "lights") {
        lights.forEach(function (light) {
          context.globalAlpha = 0.22 + (0.5 + Math.sin(elapsed * 1.4 + light.phase) * 0.5) * 0.65;
          var size = light.radius * w / 960;
          context.drawImage(glow, light.x * w - size, light.y * h - size, size * 2, size * 2);
        });
        context.globalAlpha = 1;
        return;
      }
      if (kind === "fireworks") {
        for (var burst = 0; burst < 2; burst++) {
          var age = (elapsed + burst * 3.2) % 6.5;
          if (age > 3.2) continue;
          var progress = age / 3.2;
          var centerX = w * (burst ? 0.84 : 0.16);
          var centerY = h * (burst ? 0.19 : 0.23);
          context.strokeStyle = "rgba(255,221,159," + Math.pow(1 - progress, 1.4) + ")";
          context.lineWidth = 1;
          for (var ray = 0; ray < 36; ray++) {
            var angle = ray * Math.PI * 2 / 36;
            var radius = w * 0.13 * progress * (0.86 + (ray % 5) * 0.035);
            var fall = h * 0.05 * progress * progress;
            context.beginPath();
            context.moveTo(centerX + Math.cos(angle) * radius * 0.88, centerY + Math.sin(angle) * radius * 0.88 + fall);
            context.lineTo(centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius + fall);
            context.stroke();
          }
        }
        return;
      }
      var shift = (elapsed * 42) % (w * 1.2);
      var nearShift = (elapsed * 67) % (w * 1.2);
      for (var i = -1; i < 3; i++) {
        context.globalAlpha = 0.32;
        context.drawImage(cloud, i * w * 1.2 + shift - w * 0.6, -h * 0.04, w * 1.8, h * 0.48);
        context.globalAlpha = 0.31;
        context.drawImage(mist, i * w * 1.2 + shift - w * 0.6, h * 0.44 + Math.sin(elapsed * 0.3) * h * 0.025, w * 1.5, h * 0.33);
        context.globalAlpha = 0.46;
        context.drawImage(mist, i * w * 1.2 - nearShift - w * 0.1, h * 0.67 + Math.cos(elapsed * 0.4) * h * 0.035, w * 1.8, h * 0.45);
      }
      context.globalAlpha = 1;
    }
    function tick(now) {
      frame = null;
      if (!playing) return;
      if (previous !== null) elapsed += Math.min(0.1, (now - previous) / 1000);
      previous = now;
      if (now - lastDraw >= 40) {
        draw();
        lastDraw = now;
      }
      frame = requestAnimationFrame(tick);
    }
    function setPlaying(value) {
      if (playing === value) return;
      playing = value;
      previous = null;
      if (value) frame = requestAnimationFrame(tick);
      else if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
    }
    window.addEventListener("resize", resize);
    resize();
    return {
      setPlaying: setPlaying,
      dispose: function () {
        playing = false;
        if (frame !== null) cancelAnimationFrame(frame);
        window.removeEventListener("resize", resize);
        parent.removeAttribute("data-ipas-login-fog");
        canvas.remove();
      },
    };
  }

  function ensureScene(surface) {
    if (!scene) {
      scene = document.createElement("div");
      scene.setAttribute("data-ipas-login-scene", "");
      scene.setAttribute("aria-hidden", "true");
      ["landscape", "clouds", "light", "mist-far", "mist-near", "weather", "bough", "candles"].forEach(function (name) {
        var layer = document.createElement("span");
        layer.className = "ipas-login-" + name;
        if (name === "candles") for (var i = 0; i < 3; i++) layer.appendChild(document.createElement("span"));
        scene.appendChild(layer);
      });
      motionButton = document.createElement("button");
      motionButton.type = "button";
      motionButton.setAttribute("data-ipas-login-motion-toggle", "");
      motionButton.addEventListener("click", function () {
        userPaused = !(userPaused === null ? reducedMotion.matches : userPaused);
        syncMotion();
      });
    }
    if (scene.parentElement !== surface) surface.insertBefore(scene, surface.firstChild);
    if (motionButton.parentElement !== surface) surface.appendChild(motionButton);
    var effect = surface.getAttribute("data-ipas-login-effect");
    var wanted = /^(fog|lights|fireworks)$/.test(effect) ? effect : null;
    if (wanted !== atmosphereKind) {
      if (atmosphere) atmosphere.dispose();
      atmosphere = wanted ? createAtmosphere(surface, scene, wanted) : null;
      atmosphereKind = wanted;
    }
  }

  function clearLogin() {
    if (!current) return;
    current.surface.removeAttribute("data-ipas-login");
    current.surface.removeAttribute("data-ipas-login-season");
    current.surface.removeAttribute("data-ipas-login-palette");
    current.surface.removeAttribute("data-ipas-login-scene-kind");
    current.surface.removeAttribute("data-ipas-login-effect");
    current.surface.removeAttribute("data-ipas-login-motion");
    current.card.removeAttribute("data-ipas-login-card");
    current.button.removeAttribute("data-ipas-login-submit");
    if (atmosphere) atmosphere.dispose();
    atmosphere = null;
    atmosphereKind = null;
    if (seasonTimer !== null) clearTimeout(seasonTimer);
    seasonTimer = null;
    if (scene) scene.remove();
    if (motionButton) motionButton.remove();
    scene = null;
    motionButton = null;
    userPaused = null;
    current = null;
  }

  function syncLogin() {
    queued = false;
    var found = findLogin();
    if (!found) {
      clearLogin();
      return;
    }
    if (current && current.surface !== found.surface) clearLogin();
    current = found;
    found.surface.setAttribute("data-ipas-login", "");
    var season = seasonForDate(new Date());
    var config = SEASONS[season];
    found.surface.setAttribute("data-ipas-login-season", season);
    found.surface.setAttribute("data-ipas-login-palette", config.palette);
    found.surface.setAttribute("data-ipas-login-scene-kind", config.scene);
    found.surface.setAttribute("data-ipas-login-effect", config.effect);
    found.card.setAttribute("data-ipas-login-card", "");
    found.button.setAttribute("data-ipas-login-submit", "");
    ensureScene(found.surface);
    syncMotion();
    scheduleSeasonCheck();
  }

  function queueSync() {
    if (queued) return;
    queued = true;
    // DOM changes are tagged before the browser's next paint, including logout.
    queueMicrotask(syncLogin);
  }

  var observer = new MutationObserver(queueSync);
  observer.observe(root, { childList: true, subtree: true });
  window.addEventListener("pageshow", queueSync);
  document.addEventListener("visibilitychange", function () {
    syncMotion();
    if (!document.hidden) queueSync();
  });
  if (reducedMotion.addEventListener) reducedMotion.addEventListener("change", syncMotion);
  else if (reducedMotion.addListener) reducedMotion.addListener(syncMotion);
  syncLogin();
})();
