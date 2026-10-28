const pages = [...document.querySelectorAll('.page-view')];
const pageById = new Map(pages.map((page) => [page.id, page]));
const pageLinks = [...document.querySelectorAll('[data-page-link]')];
const pageAnnouncement = document.querySelector('#page-announcement');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const lightbox = document.querySelector('.image-lightbox');
let activeLightboxTrigger = null;
const lightboxImage = lightbox?.querySelector('.lightbox-image');
const lightboxCaption = lightbox?.querySelector('#lightbox-caption');
const defaultLightbox = lightboxImage ? {
  src: lightboxImage.getAttribute('src'),
  alt: lightboxImage.getAttribute('alt'),
  width: lightboxImage.getAttribute('width'),
  height: lightboxImage.getAttribute('height'),
  caption: lightboxCaption?.textContent ?? '',
} : null;
const lightboxClose = document.querySelector('.lightbox-close');
let lightboxCloseTimeout;

function closeLightbox() {
  if (!lightbox?.open || lightbox.classList.contains('is-closing')) return;

  if (reducedMotion.matches) {
    lightbox.close();
    return;
  }

  lightbox.classList.add('is-closing');
  lightboxCloseTimeout = window.setTimeout(() => {
    lightbox.classList.remove('is-closing');
    lightbox.close();
  }, 170);
}

function setLightboxContent(trigger) {
  if (!lightboxImage || !defaultLightbox) return;
  const { lightboxSrc, lightboxAlt, lightboxCaption: caption, lightboxWidth, lightboxHeight } = trigger.dataset;
  lightboxImage.src = lightboxSrc || defaultLightbox.src;
  lightboxImage.alt = lightboxSrc ? lightboxAlt ?? '' : defaultLightbox.alt;
  lightboxImage.width = lightboxSrc ? Number(lightboxWidth) : defaultLightbox.width;
  lightboxImage.height = lightboxSrc ? Number(lightboxHeight) : defaultLightbox.height;
  if (lightboxCaption) lightboxCaption.textContent = lightboxSrc ? caption ?? '' : defaultLightbox.caption;
}

document.querySelectorAll('.image-lightbox-trigger').forEach((trigger) => {
  trigger.addEventListener('click', () => {
    if (!lightbox?.showModal) return;
    activeLightboxTrigger = trigger;
    setLightboxContent(trigger);
    lightbox.showModal();
    lightboxClose?.focus();
  });
});

lightboxClose?.addEventListener('click', closeLightbox);

lightbox?.addEventListener('click', (event) => {
  if (event.target === lightbox) closeLightbox();
});

lightbox?.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeLightbox();
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !lightbox?.open) return;
  event.preventDefault();
  closeLightbox();
});

lightbox?.addEventListener('close', () => {
  window.clearTimeout(lightboxCloseTimeout);
  lightbox.classList.remove('is-closing');
  (activeLightboxTrigger ?? document.querySelector('.image-lightbox-trigger'))?.focus();
});

const projectGallery = document.querySelector('.project-gallery');
const projectGalleryImage = projectGallery?.querySelector('.project-gallery-image');
const projectGalleryCaption = projectGallery?.querySelector('.project-gallery-caption');
const projectGalleryPosition = projectGallery?.querySelector('.project-gallery-position');
const projectGalleryClose = projectGallery?.querySelector('.project-gallery-close');
const galleryPrevious = projectGallery?.querySelector('.gallery-previous');
const galleryNext = projectGallery?.querySelector('.gallery-next');
const projectGalleryTitle = projectGallery?.querySelector('#project-gallery-title');
const projectGalleryStage = projectGallery?.querySelector('.project-gallery-stage');
const projectGalleryFrame = projectGallery?.querySelector('.project-gallery-image-frame');
const projectGalleryThumbnails = projectGallery?.querySelector('.project-gallery-thumbnails');
let activeGalleryTrigger;
let activeGalleryPhotos = [];
let activeGalleryIndex = 0;

const projectImageManifest = (() => {
  const manifest = document.querySelector('#project-image-manifest');
  if (!manifest) return {};

  try {
    return JSON.parse(manifest.textContent);
  } catch {
    return {};
  }
})();

function renderProjectFolderPreviews() {
  document.querySelectorAll('[data-project-gallery]').forEach((container) => {
    const projectName = container.dataset.projectGallery;
    const photos = projectImageManifest[projectName] ?? [];
    if (!photos.length) return;

    const projectCard = container.closest('.research-project-card');
    const heading = projectCard?.querySelector('h3')?.textContent.trim() || projectName;
    const galleryPhotos = photos.map((photo) => ({
      src: photo.src,
      alt: photo.alt,
      caption: photo.caption || photo.alt,
      width: photo.width,
      height: photo.height,
    }));

    const preview = document.createElement('figure');
    preview.className = 'project-image';

    const image = document.createElement('img');
    Object.assign(image, {
      src: photos[0].src,
      alt: photos[0].alt,
      width: photos[0].width,
      height: photos[0].height,
      loading: 'lazy',
      decoding: 'async',
    });

    const caption = document.createElement('figcaption');
    caption.textContent = photos[0].caption || photos[0].alt;
    preview.append(image, caption);

    const trigger = document.createElement('button');
    trigger.className = 'project-gallery-open';
    trigger.type = 'button';
    trigger.dataset.galleryOpen = projectName;
    trigger.setAttribute('aria-label', `See all ${galleryPhotos.length} photos for ${heading}`);
    trigger.append(document.createTextNode('See more '));

    const count = document.createElement('span');
    count.className = 'gallery-photo-count';
    count.textContent = `${galleryPhotos.length} ${galleryPhotos.length === 1 ? 'photo' : 'photos'}`;
    trigger.append(count);

    container.replaceChildren(preview);

    const readMore = projectCard?.querySelector('.read-more-open');
    if (readMore) {
      const actions = document.createElement('div');
      actions.className = 'research-row-actions';
      readMore.before(actions);
      actions.append(trigger, readMore);
    } else {
      container.append(trigger);
    }
    trigger.addEventListener('click', () => openProjectGallery(trigger, heading, galleryPhotos));
  });
}

function openProjectGallery(trigger, title, photos) {
  if (!projectGallery?.showModal || photos.length === 0) return;
  activeGalleryTrigger = trigger;
  activeGalleryPhotos = photos;
  activeGalleryIndex = 0;
  if (projectGalleryTitle) projectGalleryTitle.textContent = title;
  buildProjectGalleryThumbnails(photos);
  projectGallery.showModal();
  renderProjectGalleryPhoto();
  projectGalleryClose?.focus();
}

function renderProjectGalleryPhoto() {
  const photo = activeGalleryPhotos[activeGalleryIndex];
  if (!photo || !projectGalleryImage) return;

  projectGalleryImage.src = photo.src;
  projectGalleryImage.alt = photo.alt;
  projectGalleryImage.onload = fitProjectGalleryImage;
  if (projectGalleryCaption) projectGalleryCaption.textContent = photo.caption;
  if (projectGalleryPosition) {
    projectGalleryPosition.textContent = `Photo ${activeGalleryIndex + 1} of ${activeGalleryPhotos.length}`;
  }

  requestAnimationFrame(fitProjectGalleryImage);
  projectGalleryThumbnails?.querySelectorAll('.gallery-thumbnail').forEach((thumbnail, index) => {
    thumbnail.setAttribute('aria-pressed', String(index === activeGalleryIndex));
  });

  const showNavigation = activeGalleryPhotos.length > 1;
  if (galleryPrevious) galleryPrevious.hidden = !showNavigation;
  if (galleryNext) galleryNext.hidden = !showNavigation;
}

function fitProjectGalleryImage() {
  if (!projectGalleryImage || !projectGalleryStage || !projectGalleryFrame) return;
  const sourceWidth = projectGalleryImage.naturalWidth;
  const sourceHeight = projectGalleryImage.naturalHeight;
  const availableWidth = projectGalleryStage.clientWidth;
  const availableHeight = projectGalleryStage.clientHeight;
  if (!sourceWidth || !sourceHeight || !availableWidth || !availableHeight) return;

  const scale = Math.min(availableWidth / sourceWidth, availableHeight / sourceHeight, 1);
  projectGalleryFrame.style.width = `${Math.round(sourceWidth * scale)}px`;
  projectGalleryFrame.style.height = `${Math.round(sourceHeight * scale)}px`;
}

function buildProjectGalleryThumbnails(photos) {
  if (!projectGalleryThumbnails) return;
  projectGalleryThumbnails.replaceChildren();
  projectGalleryThumbnails.hidden = photos.length < 2;

  photos.forEach((photo, index) => {
    const thumbnail = document.createElement('button');
    thumbnail.type = 'button';
    thumbnail.className = 'gallery-thumbnail';
    thumbnail.setAttribute('aria-label', `View photo ${index + 1}: ${photo.caption}`);
    thumbnail.setAttribute('aria-pressed', String(index === activeGalleryIndex));
    thumbnail.addEventListener('click', () => {
      activeGalleryIndex = index;
      renderProjectGalleryPhoto();
    });

    const image = document.createElement('img');
    image.src = photo.src;
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    thumbnail.append(image);
    projectGalleryThumbnails.append(thumbnail);
  });
}

window.addEventListener('resize', () => {
  if (projectGallery?.open) requestAnimationFrame(fitProjectGalleryImage);
});

document.querySelectorAll('[data-gallery-open]').forEach((trigger) => {
  const projectCard = trigger.closest('.research-project-card');
  const photos = projectImageManifest[trigger.dataset.galleryOpen] ?? [...(projectCard?.querySelectorAll('[data-gallery-photo] img') ?? [])].map((image) => ({
    src: image.currentSrc || image.src,
    alt: image.alt,
    caption: image.closest('figure')?.querySelector('figcaption')?.textContent.trim() || image.alt,
  }));
  const count = trigger.querySelector('.gallery-photo-count');
  if (count) count.textContent = `${photos.length} ${photos.length === 1 ? 'photo' : 'photos'}`;

  trigger.addEventListener('click', () => {
    const projectTitle = projectCard?.querySelector('h3')?.textContent.trim() || 'Project photos';
    const galleryItems = photos.map((photo) => photo instanceof HTMLImageElement ? ({
      src: photo.currentSrc || photo.src,
      alt: photo.alt,
      caption: photo.closest('figure')?.querySelector('figcaption')?.textContent.trim() || photo.alt,
    }) : photo);
    openProjectGallery(trigger, projectTitle, galleryItems);
  });
});

renderProjectFolderPreviews();

galleryPrevious?.addEventListener('click', () => {
  if (!activeGalleryPhotos.length) return;
  activeGalleryIndex = (activeGalleryIndex - 1 + activeGalleryPhotos.length) % activeGalleryPhotos.length;
  renderProjectGalleryPhoto();
});

galleryNext?.addEventListener('click', () => {
  if (!activeGalleryPhotos.length) return;
  activeGalleryIndex = (activeGalleryIndex + 1) % activeGalleryPhotos.length;
  renderProjectGalleryPhoto();
});

projectGalleryClose?.addEventListener('click', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (projectGallery?.open) projectGallery.close();
});
projectGallery?.addEventListener('click', (event) => {
  if (event.target === projectGallery) projectGallery.close();
});
projectGallery?.addEventListener('cancel', (event) => {
  event.preventDefault();
  if (projectGallery.open) projectGallery.close();
});
projectGallery?.addEventListener('close', () => activeGalleryTrigger?.focus());
document.addEventListener('keydown', (event) => {
  if (!projectGallery?.open) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    projectGallery.close();
    return;
  }
  if (activeGalleryPhotos.length < 2) return;
  if (event.key === 'ArrowLeft') galleryPrevious?.click();
  if (event.key === 'ArrowRight') galleryNext?.click();
});

const contactForm = document.querySelector('#contact-form');
const errorSummary = document.querySelector('#form-error-summary');
const errorList = document.querySelector('#form-error-list');
const formStatus = document.querySelector('#form-status');
const requiredFields = [...(contactForm?.querySelectorAll('[required]') ?? [])];

function validationMessage(field) {
  if (field.validity.valueMissing) return 'This field is required.';
  if (field.validity.typeMismatch && field.type === 'email') return 'Enter a valid email address, such as name@example.com.';
  if (field.validity.tooShort) return `Please enter at least ${field.minLength} characters.`;
  return '';
}

function validateField(field) {
  const message = validationMessage(field);
  const errorElement = document.querySelector(`#${field.id}-error`);
  if (message) field.setAttribute('aria-invalid', 'true');
  else field.removeAttribute('aria-invalid');
  if (errorElement) errorElement.textContent = message;
  return message;
}

requiredFields.forEach((field) => {
  field.addEventListener('blur', () => validateField(field));
  field.addEventListener('input', () => {
    if (field.hasAttribute('aria-invalid')) validateField(field);
    if (formStatus) formStatus.textContent = '';
  });
});

contactForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  const invalidFields = requiredFields
    .map((field) => ({ field, message: validateField(field) }))
    .filter(({ message }) => message);

  if (errorList) errorList.replaceChildren();
  if (invalidFields.length) {
    if (errorSummary && errorList) {
      errorSummary.hidden = false;
      invalidFields.forEach(({ field, message }) => {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = `#${field.id}`;
        link.textContent = `${field.labels?.[0]?.textContent.trim() || 'Field'}: ${message}`;
        link.addEventListener('click', () => field.focus());
        item.append(link);
        errorList.append(item);
      });
      errorSummary.focus();
    }
    if (formStatus) formStatus.textContent = 'Please correct the highlighted fields before continuing.';
    return;
  }

  if (errorSummary) errorSummary.hidden = true;
  const values = new FormData(contactForm);
  const subject = String(values.get('subject') || 'Portfolio enquiry');
  const body = [
    `Name: ${values.get('name')}`,
    `Email: ${values.get('email')}`,
    values.get('organization') ? `Organization: ${values.get('organization')}` : '',
    '',
    String(values.get('message') || ''),
  ].filter((line, index) => line || index > 2).join('\n');
  if (formStatus) formStatus.textContent = 'Opening your email app with the message filled in…';
  window.location.href = `mailto:yaronogen@gmail.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
});

function showPage(pageId, { updateHistory = false } = {}) {
  const page = pageById.get(pageId) ?? pageById.get('home');
  if (!page) return;

  pages.forEach((view) => {
    view.hidden = view !== page;
  });

  pageLinks.forEach((link) => {
    if (link.dataset.pageLink === page.id) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  });

  const newHash = `#${page.id}`;
  if (updateHistory && window.location.hash !== newHash) {
    window.history.pushState({ page: page.id }, '', newHash);
  }

  const title = page.dataset.pageTitle || 'Home';
  document.title = `${title} | Dr. Yaron Ogen`;
  if (pageAnnouncement) pageAnnouncement.textContent = `${title} page opened`;
  window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

document.addEventListener('click', (event) => {
  const target = event.target;
  const link = target instanceof Element ? target.closest('a[href^="#"]') : null;
  if (!link) return;

  const pageId = link.getAttribute('href').slice(1);
  if (!pageById.has(pageId)) return;

  event.preventDefault();
  showPage(pageId, { updateHistory: true });
});

function showPageFromHash() {
  const pageId = window.location.hash.slice(1);
  showPage(pageById.has(pageId) ? pageId : 'home');
}

window.addEventListener('popstate', showPageFromHash);
window.addEventListener('hashchange', showPageFromHash);
showPageFromHash();

const portraitDialog = document.querySelector('#portrait-dialog');
const portraitClose = portraitDialog?.querySelector('.portrait-close');

document.querySelectorAll('[data-portrait-open]').forEach((opener) => {
  opener.addEventListener('click', () => {
    if (!portraitDialog?.showModal) return;
    portraitDialog.showModal();
    portraitClose?.focus();
  });
});

portraitClose?.addEventListener('click', () => portraitDialog.close());

portraitDialog?.addEventListener('click', (event) => {
  if (event.target === portraitDialog) portraitDialog.close();
});

const currentYear = String(new Date().getFullYear());
document.querySelectorAll('#current-year, #sidebar-year').forEach((element) => {
  element.textContent = currentYear;
});

document.querySelectorAll('.read-more-open').forEach((button) => {
  const dialog = document.getElementById(button.getAttribute('aria-controls'));
  if (!dialog?.showModal) return;

  button.addEventListener('click', () => dialog.showModal());
  dialog.querySelector('.read-more-close')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
});
