(() => {
  const setupPair = (trackId, clusterId) => {
    const track = document.getElementById(trackId);
    const cluster = document.getElementById(clusterId);
    if (!track || !cluster) return;
    const update = () => {
      for (const option of [...cluster.options].slice(1)) {
        const matches = option.dataset.track === track.value;
        option.hidden = !matches;
        option.disabled = !matches;
      }
      if (cluster.selectedOptions[0]?.dataset.track !== track.value) cluster.value = '';
    };
    track.addEventListener('change', update);
    update();
  };
  setupPair('pre-track', 'pre-cluster');
  setupPair('section-track', 'section-cluster');
})();
