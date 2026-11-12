# Birdsong Atlas

Birdsong Atlas is a mobile-first progressive web app for recording, identifying, and visualizing bird sounds. This repository contains the files served by GitHub Pages.

## Run locally

From this directory, run:

```sh
python3 -m http.server 8000
```

Open http://localhost:8000. For access from a phone, serve the site files from an HTTPS static host. Open it on the phone and use your browser’s Add to Home Screen or Install option. The microphone and location features require a secure context and browser permissions.

## Use the recorder

Choose **Record**, then **Stop**, or use **Import audio**. Set the start and end, replay the selection, and choose **Analyze selection**. Use **Crop** to return to the original audio. The app analyzes up to 60 seconds per recording. The first identification downloads the acoustic model and its inference runtime. Enabling location downloads a separate occurrence model when there are acoustic candidates. Audio processing and location-based ranking happen on the device.

The opening soundscape uses synthesized audio and illustrative detections. Select a species to highlight the time windows that support the detection. These windows still contain the original mixed audio. Drag or pinch the 3D plot and tap a point to inspect its frame metadata and seek to the corresponding time.

The 3D manifold opens in **Animated** mode. The connected trail fades over 5.5 seconds. Nodes swell when a similar dominant frequency returns after a gap or change in pitch. The animation previews the recording silently and follows the playhead during playback. Use **Pause animation** to hold the trail or **Complete** to see the entire trajectory at once. The animation starts paused if your device requests reduced motion.

## Method and credits

The 3D projection follows the supplied 40-MFCC, three-component PCA specification and is inspired by Lucio Arese’s [Seeing Birdsong](https://www.lucioarese.net/seeing-birdsong/). PCA is fitted independently per recording. The chart maps spectral centroid to point color. RMS amplitude sets the base point size, with extra growth for recurring frequencies in Animated mode.

Powered by [BirdNET](https://birdnet.cornell.edu/) from the Cornell Lab of Ornithology and Chemnitz University of Technology. The [v2.4 acoustic weights](https://huggingface.co/tphakala/BirdNET-v2.4) are licensed CC BY-NC-SA 4.0. The [v3.0.4 geomodel](https://huggingface.co/tphakala/BirdNET-Geomodel) is licensed Apache 2.0. The app retrieves these weights on demand. Wikimedia Commons photo credits are available in **The method**.
