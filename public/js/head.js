// Runs in <head> before the first paint (kept as a file because the site's security policy blocks inline scripts).
// m-enter: the hero waits for motion.js to fade it in once; m-enter-done shows it anyway after 700 ms.
// mo-js / mo-safe: the photo moment waits for its script; mo-safe shows it anyway after 2.5 s.
document.documentElement.classList.add('m-enter', 'mo-js');
setTimeout(function () { document.documentElement.classList.add('m-enter-done'); }, 700);
setTimeout(function () { document.documentElement.classList.add('mo-safe'); }, 2500);
