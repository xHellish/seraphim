// =============================================
// AXM web style - comportamiento reutilizable
// Partículas al pasar el cursor, glitch en momentos clave y navegación por secciones.
// Se carga al final del <body>: <script src="js/axm.js"></script>
// ---------------------------------------------

// =============================================
// Constantes
// ---------------------------------------------
const AX_PARTICLES_ON_ENTER = 6;
const AX_PARTICLES_PER_TICK = 2;
const AX_PARTICLE_TICK_MS = 160;
const AX_PARTICLE_LIFETIME_MS = 750;
const AX_GLITCH_DURATION_MS = 450;
const AX_PARTICLE_TARGETS = '.ax_card, .ax_button';

// =============================================
// Glitch
// ---------------------------------------------

// Reproduce el glitch corto en un elemento (usar solo en momentos clave)
function ax_play_glitch(element) {
  element.classList.remove('ax_glitching');
  // Fuerza un reflow para que la animación vuelva a empezar
  void element.offsetWidth;
  element.classList.add('ax_glitching');
  setTimeout(function () {
    element.classList.remove('ax_glitching');
  }, AX_GLITCH_DURATION_MS);
}

// =============================================
// Partículas
// ---------------------------------------------

// Lanza partículas pixel en el color --accent del elemento
function ax_spawn_particles(element, amount) {
  const rect = element.getBoundingClientRect();
  const accent = getComputedStyle(element).getPropertyValue('--accent').trim();

  for (let index = 0; index < amount; index++) {
    // Posición al azar en la franja superior del elemento
    const particle = document.createElement('span');
    particle.className = 'ax_particle';
    particle.style.left = (rect.left + Math.random() * rect.width) + 'px';
    particle.style.top = (rect.top + Math.random() * Math.min(rect.height, 40)) + 'px';
    particle.style.background = accent;
    particle.style.setProperty('--drift_x', ((Math.random() - 0.5) * 16) + 'px');
    particle.style.animationDelay = (index * 40) + 'ms';
    document.body.appendChild(particle);

    // Se borra al terminar su animación
    setTimeout(function () {
      particle.remove();
    }, AX_PARTICLE_LIFETIME_MS + index * 40);
  }
}

// Emite partículas mientras el cursor esté sobre cartas y botones
function ax_setup_particles() {
  const reduce_motion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce_motion) {
    return;
  }

  const elements = document.querySelectorAll(AX_PARTICLE_TARGETS);
  for (const element of elements) {
    let emitter = null;

    // Ráfaga al entrar y emisión continua mientras siga encima
    element.addEventListener('pointerenter', function () {
      ax_spawn_particles(element, AX_PARTICLES_ON_ENTER);
      if (emitter === null) {
        emitter = setInterval(function () {
          ax_spawn_particles(element, AX_PARTICLES_PER_TICK);
        }, AX_PARTICLE_TICK_MS);
      }
    });

    // Al salir deja de emitir; las que ya salieron terminan su animación
    element.addEventListener('pointerleave', function () {
      if (emitter !== null) {
        clearInterval(emitter);
        emitter = null;
      }
    });
  }
}

// =============================================
// Navegación por secciones (opcional)
// Botones: <button class="ax_frame ax_button ax_nav_button" data-section="id">
// Secciones: <section class="ax_section" id="id"> con un título .ax_glitch_target
// ---------------------------------------------

// Muestra una sección, marca su botón y dispara el glitch de su título
function ax_go_to_section(section_id) {
  const target = document.getElementById(section_id);
  if (target === null) {
    throw new Error('Section not found: ' + section_id);
  }

  // Oculta todas las secciones y muestra la elegida
  const sections = document.querySelectorAll('.ax_section');
  for (const section of sections) {
    section.hidden = true;
  }
  target.hidden = false;

  // Marca como activo solo el botón de esa sección
  const buttons = document.querySelectorAll('.ax_nav_button[data-section]');
  for (const button of buttons) {
    if (button.dataset.section === section_id) {
      button.classList.add('active');
    } else {
      button.classList.remove('active');
    }
  }

  // Glitch del título al entrar
  const title = target.querySelector('.ax_glitch_target');
  if (title !== null) {
    ax_play_glitch(title);
  }
}

// Conecta los botones de navegación y abre la primera sección
function ax_setup_navigation() {
  const buttons = document.querySelectorAll('.ax_nav_button[data-section]');
  if (buttons.length === 0) {
    return;
  }

  for (const button of buttons) {
    button.addEventListener('click', function () {
      ax_go_to_section(button.dataset.section);
    });
  }
  ax_go_to_section(buttons[0].dataset.section);
}

// =============================================
// Inicio
// ---------------------------------------------
ax_setup_navigation();
ax_setup_particles();
