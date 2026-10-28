# Website project image workflow

- Match folders under `images/` to their project card by project name; do not move or rename the user's files.
- When a new project folder or image is added, include its images in the matching Research or Other Projects card and its “See more” gallery.
- Keep one representative image visible as a small, uncropped preview; “See more” opens the complete project photo gallery.
- Add meaningful alt text and a short caption for every image. Do not infer project findings, locations, species, dates, or methods solely from a filename or photo.
- This is a static site, so the browser cannot enumerate folders at runtime. Keep the image file list synchronized in the project card markup when folders change.
- Check all existing folders in `images/` against the project names in Research and Other Projects. A newly added folder named for an existing project is a request to display those images in that project's card/gallery; add any future files there as well.
- For every project folder, show one representative full-image thumbnail and a “See more” button for the folder's complete image set. Use the project gallery dialog and set its title from the card heading.
- Keep galleries keyboard-operable, with a visible close button, Escape/backdrop dismissal, focus restoration, responsive image containment, and reduced-motion support.