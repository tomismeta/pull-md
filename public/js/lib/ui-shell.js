(function attachPullMdUiShell(globalScope) {
  if (!globalScope || typeof globalScope !== 'object') return;

  function setModalVisible(modalId, visible) {
    const id = String(modalId || '').trim();
    if (!id) return;
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.style.display = visible ? 'flex' : 'none';
  }

  function openModal(modalId) {
    setModalVisible(modalId, true);
  }

  function closeModal(modalId) {
    setModalVisible(modalId, false);
  }

  function initMobileNav({
    toggleId = 'navToggle',
    navId = 'topNav',
    mobileMaxWidth = 760
  } = {}) {
    const toggle = document.getElementById(toggleId);
    const nav = document.getElementById(navId);
    if (!toggle || !nav) return;
    if (toggle.dataset.pullmdNavBound === '1') return;
    toggle.dataset.pullmdNavBound = '1';

    const closeNav = () => {
      nav.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    };

    toggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const nextOpen = !nav.classList.contains('open');
      nav.classList.toggle('open', nextOpen);
      toggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
    });

    nav.querySelectorAll('a, button').forEach((item) => {
      item.addEventListener('click', () => {
        if (window.innerWidth <= mobileMaxWidth) closeNav();
      });
    });

    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!nav.contains(target) && !toggle.contains(target)) closeNav();
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth > mobileMaxWidth) closeNav();
    });
  }

  globalScope.PullMdUiShell = {
    setModalVisible,
    openModal,
    closeModal,
    initMobileNav
  };
})(typeof window !== 'undefined' ? window : globalThis);
