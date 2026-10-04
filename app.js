const tourGrid = document.getElementById('tourGrid');
const bookingForm = document.getElementById('bookingForm');
const bookingResult = document.getElementById('bookingResult');
const toast = document.getElementById('toast');
const mileageLookupForm = document.getElementById('mileageLookupForm');
const mileageResult = document.getElementById('mileageResult');
const checkinForm = document.getElementById('checkinForm');
const checkinResult = document.getElementById('checkinResult');

const airportOptions = [
  'Greater Rockford Airport','Boltic Airfield',
  'Larnaca International Airport','Paphos International Airport','Barra Airport','Henstridge Airfield',
  'Tokyo International Airport','Saba Airport','Bird Island Airfield',
  'Perth International Airport','Lukla Airstrip',
  'Keflavik International Airport','Pingeyri Airport',
  'Izolirani International Airport','Al Najaf Airfield',
  'Sauthemptona Airport','Saint Barthélemy Airport','Skopelos Airfield'
];

let lastMileageIdentity = { discord: '', roblox: '' };

document.getElementById('year').textContent = new Date().getFullYear();

document.getElementById('mobileMenu').addEventListener('click', () => {
  const nav = document.getElementById('mainNav');
  nav.style.display = nav.style.display === 'flex' ? 'none' : 'flex';
  nav.style.position = 'absolute'; nav.style.top = '78px'; nav.style.left = '0'; nav.style.right = '0'; nav.style.padding = '18px'; nav.style.background = '#061426'; nav.style.flexDirection = 'column'; nav.style.alignItems = 'stretch';
});

function showToast(message) {
  toast.textContent = message; toast.classList.add('show'); clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]));
}

async function copyText(text, label='Copied to clipboard.') {
  try { await navigator.clipboard.writeText(text); showToast(label); }
  catch { showToast('Copy failed. Select the text manually.'); }
}


function formatTourTime(tour) {
  if (!tour.start_timestamp) {
    return `<strong>${escapeHtml(tour.time)}</strong><span class="tour-time-zone">${escapeHtml(tour.timezone || 'Local time')}</span>`;
  }
  const date = new Date(Number(tour.start_timestamp) * 1000);
  const local = date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const relative = getRelativeTime(date);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'your local timezone';
  return `<strong>${escapeHtml(local)}</strong><span class="tour-time-zone">Your local time • ${escapeHtml(zone)}</span><span class="tour-countdown">${escapeHtml(relative)}</span>`;
}

function getRelativeTime(date) {
  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(diffSeconds);
  if (abs < 60) return diffSeconds >= 0 ? 'Starts in less than a minute' : 'Started less than a minute ago';
  const units = [
    [31536000, 'year'],
    [2592000, 'month'],
    [604800, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute']
  ];
  for (const [seconds, unit] of units) {
    if (abs >= seconds) {
      const value = Math.round(diffSeconds / seconds);
      return new Intl.RelativeTimeFormat(undefined, { numeric: 'always' }).format(value, unit);
    }
  }
  return '';
}

function tourCard(tour) {
  const disabled = tour.status === 'Cancelled' || tour.status === 'Completed';
  const publicTour = tour.type === 'Public';
  const actionLabel = publicTour ? 'Request a Seat' : 'Request Tour';
  return `<article class="tour-card">
    <span class="tour-type">${escapeHtml(tour.type)} TOUR</span>
    <h3>${escapeHtml(tour.title)}</h3>
    <div class="tour-route">🛫 ${escapeHtml(tour.origin)} → ${escapeHtml(tour.destination)}</div>
    <div class="tour-meta"><div>DATE<strong>${escapeHtml(tour.date)}</strong></div><div>TIME${formatTourTime(tour)}</div><div>AIRCRAFT<strong>${escapeHtml(tour.aircraft)}</strong></div><div>CAPACITY<strong>${escapeHtml(tour.capacity)} seats</strong></div></div>
    ${tour.description ? `<p class="muted">${escapeHtml(tour.description)}</p>` : ''}
    <div class="tour-actions"><button class="small-btn primary" ${disabled ? 'disabled' : ''} onclick="selectTour('${escapeHtml(tour.id)}','${escapeHtml(tour.type)}')">${actionLabel}</button><button class="small-btn" onclick="copyPublicTour('${encodeURIComponent(JSON.stringify(tour))}')">Copy for Discord</button></div>
  </article>`;
}

window.selectTour = function(id, type) {
  document.getElementById('private').scrollIntoView({ behavior: 'smooth' });
  bookingForm.elements.tourId.value = id;
  bookingForm.elements.tourType.value = type || 'Public';
  showToast(type === 'Public' ? 'Public tour selected. Complete the booking form below.' : 'Private tour request selected.');
};

window.copyPublicTour = function(encoded) {
  const tour = JSON.parse(decodeURIComponent(encoded));
  const timestamp = Number(tour.start_timestamp || 0);
  const timeLine = timestamp
    ? `📅 **Date:** <t:${timestamp}:D>\n⏰ **Time:** <t:${timestamp}:t>\n🕒 **Starts:** <t:${timestamp}:F> (<t:${timestamp}:R>)\n`
    : `📅 **Date:** ${tour.date}\n⏰ **Time:** ${tour.time}\n`;
  const text = `@everyone\n\n# ✈️ ${tour.title} #\n\n🌎 **TOUR DETAILS**\n\n${timeLine}🛫 **Route:** ${tour.origin} → ${tour.destination}\n✈️ **Aircraft:** ${tour.aircraft}\n👥 **Capacity:** ${tour.capacity}\n🎟️ **Type:** ${tour.type}\n\n${tour.description ? `${tour.description}\n\n` : ''}🔗 **Book / Details:** ${location.origin}/#tours\n\nPTFS Tour Services\nYour Flight. Your Tour. Your Experience.`;
  copyText(text, 'Discord announcement copied.');
};

async function loadTours() {
  try {
    const response = await fetch('/api/tours'); const tours = await response.json();
    if (!tours.length) tourGrid.innerHTML = '<div class="empty">No tours are scheduled yet. Check back soon, or request a private tour below.</div>';
    else tourGrid.innerHTML = tours.map(tourCard).join('');
  } catch { tourGrid.innerHTML = '<div class="empty">The tour board is temporarily unavailable. Please try again shortly.</div>'; }
}

bookingForm.addEventListener('submit', async e => {
  e.preventDefault();
  const button = bookingForm.querySelector('button[type="submit"]'); button.disabled = true; button.textContent = 'Submitting…';
  const body = Object.fromEntries(new FormData(bookingForm).entries());
  try {
    const response = await fetch('/api/bookings', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Booking failed.');
    bookingResult.classList.remove('hidden');
    bookingResult.innerHTML = `<div class="copy-row"><strong>${data.booking.status === 'Waitlisted' ? 'Request waitlisted ⏳' : 'Request submitted ✓'}</strong><button class="small-btn" id="copyConfirmation">Copy for Discord</button></div><p class="muted">${escapeHtml(data.message)} Your confirmation code is <strong>${escapeHtml(data.booking.confirmation_code)}</strong>. Keep it for online check-in.</p><pre>${escapeHtml(data.confirmation)}</pre>`;
    document.getElementById('copyConfirmation').onclick = () => copyText(data.confirmation, 'Booking confirmation copied.');
    bookingForm.reset(); bookingForm.elements.passengers.value = 1; bookingForm.elements.tourType.value = 'Private'; bookingForm.elements.tourId.value = '';
    showToast(data.booking.status === 'Waitlisted' ? 'Request placed on the waitlist.' : 'Tour request submitted.');
    loadTours();
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; button.textContent = 'Submit Tour Request'; }
});

mileageLookupForm.addEventListener('submit', async e => {
  e.preventDefault();
  const button = mileageLookupForm.querySelector('button'); button.disabled = true; button.textContent = 'Loading…';
  const body = Object.fromEntries(new FormData(mileageLookupForm).entries());
  lastMileageIdentity = { discord: body.discord, roblox: body.roblox };
  try {
    const response = await fetch(`/api/mileage?discord=${encodeURIComponent(body.discord)}&roblox=${encodeURIComponent(body.roblox)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load mileage.');
    renderMileage(data);
    showToast('Mileage loaded.');
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; button.textContent = 'View Mileage'; }
});

function renderMileage(data) {
  const tierText = data.tier === 'None' ? 'No membership' : `${data.tier} member`;
  mileageResult.classList.remove('hidden');
  mileageResult.innerHTML = `<div class="mileage-total"><span>Current mileage</span><strong>${Number(data.miles).toLocaleString()}</strong></div><div class="mileage-tier">${escapeHtml(tierText)}</div><div class="mileage-actions"><button class="small-btn primary" data-inline-redeem="Priority">Redeem Priority · 1,500</button><button class="small-btn" data-inline-redeem="Executive">Redeem Executive · 3,000</button></div>`;
  mileageResult.querySelectorAll('[data-inline-redeem]').forEach(btn => btn.addEventListener('click', () => redeemMembership(btn.dataset.inlineRedeem)));
}

async function redeemMembership(tier) {
  if (!lastMileageIdentity.discord || !lastMileageIdentity.roblox) {
    showToast('Check your mileage first.'); return;
  }
  if (!confirm(`Redeem ${tier} membership using your mileage?`)) return;
  try {
    const response = await fetch('/api/mileage/redeem', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ discordUsername:lastMileageIdentity.discord, robloxUsername:lastMileageIdentity.roblox, tier }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not redeem membership.');
    renderMileage(data);
    showToast(`${tier} membership redeemed.`);
  } catch (error) { showToast(error.message); }
}

document.querySelectorAll('.redeem-btn').forEach(button => button.addEventListener('click', () => {
  document.getElementById('mileage').scrollIntoView({ behavior: 'smooth' });
  showToast(`Check your mileage, then redeem ${button.dataset.tier}.`);
}));

checkinForm.addEventListener('submit', async e => {
  e.preventDefault();
  const button = checkinForm.querySelector('button'); button.disabled = true; button.textContent = 'Checking in…';
  const body = Object.fromEntries(new FormData(checkinForm).entries());
  try {
    const response = await fetch('/api/checkin', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Check-in failed.');
    checkinResult.classList.remove('hidden');
    checkinResult.innerHTML = `<strong>${data.alreadyCheckedIn ? 'Already checked in ✓' : 'Online check-in complete ✓'}</strong><p class="muted">Confirmation: <strong>${escapeHtml(data.confirmationCode)}</strong>${data.checkedInAt ? ` • Checked in at ${escapeHtml(new Date(data.checkedInAt).toLocaleString())}` : ''}</p>${data.startTimestamp ? `<p class="muted">Tour time: <strong>${escapeHtml(new Date(Number(data.startTimestamp) * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</strong> in your local timezone.</p>` : ''}`;
    showToast(data.alreadyCheckedIn ? 'You are already checked in.' : 'Online check-in complete.');
  } catch (error) { showToast(error.message); }
  finally { button.disabled = false; button.textContent = 'Check In Online'; }
});

loadTours();
