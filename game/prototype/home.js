// Preserve existing shared game links when the former game entry becomes the home.
if (location.search) {
  location.replace(`./play.html${location.search}${location.hash}`);
}
