# Independent real-recording BPM/key baseline — 2026-09-23

## Result and scope

`scripts/benchmark-real-audio.mjs` was run against **28 actual GuitarSet v1.1.0 microphone recordings**, 73,132,258 audio bytes total, with tempo/key references read from the original JAMS annotation archive. The deterministic selection was the first 28 of 30 composition slots for player `00`, one performance per composition, alternating comp/solo. The acquisition service returned HTTP 429 before slots 29–30 and the six planned second-player recordings; all 28 already acquired samples were kept, with no selection based on analyzer output. This is a **single-player, short-guitar-excerpt** baseline, not a representative sample of FL Studio beats or a general accuracy claim.

The [primary Zenodo release](https://zenodo.org/records/3371780) describes recorded guitar audio and reports that version 1.1.0 adds key annotations. Its [record API](https://zenodo.org/api/records/3371780) declares **CC BY 4.0** (`metadata.license.id`); the audio and JAMS archive were used only in ignored, test-owned `test-results/dsp-real/`, and are not committed or bundled. A [Hugging Face repack](https://huggingface.co/datasets/jhartquist/guitarset) delivered the individual microphone WAVs; the reference tempo and key came from Zenodo's original `annotation.zip`, whose MD5 matched its published `b39b78e63d3446f2e54ddb7a54df9b10`. The repack delivery is disclosed because its bytes were not compared against Zenodo's 657 MB microphone ZIP. The original dataset's score/design labels are independent of Sonic's acoustic estimator, but this cohort does not provide a human perceptual-tempo adjudication for each excerpt.

| Outcome | Tempo | Key |
| --- | ---: | ---: |
| Positive recordings | 28 | 28 |
| Exact primary estimate (±2 BPM for tempo) | **10/28** | **11/28** |
| Exact label only in alternatives | 2/28 | 12/28 |
| Half/double only, primary or alternative | 6/28 | — |
| Abstained | 9/28 | 4/28 (3 retain exact key as alternative) |
| Neither exact nor half/double/correct alternative | 1/28 | 1/28 |
| Positive estimate coverage | 19/28 (67.9%) | 24/28 (85.7%) |
| Relative-key primary | — | 0/28 |
| Annotated real negative examples | **0** | **0** |

The negative false-positive rate is **unmeasured**, not zero. The unchanged synthetic suite remains **20/22 required cases passing**, with two strict exact-key requirements unresolved; this benchmark does not change its tests or annotations. The real-recording results reveal a material gap between an available candidate and a dependable primary BPM/key for DAW use. For example, `r007` has a 114 BPM reference but reports about 153.4 BPM primary without a 114 BPM candidate; `r021` has D minor reference but reports G minor primary without D minor among its candidates. Both remain failures in the report.

The harness compiles `src/main/analysis/dsp.ts` from source through the project's local esbuild and decodes each file to 22,050 Hz mono PCM with FFmpeg. Opaque `rNNN.wav` filenames are passed to FFmpeg; **only PCM, sample rate, and duration** reach `estimateTempo` and `estimateKey`. Tags, titles, original file IDs, JAMS labels, filenames, and expected values are not passed to those functions. It uses the same short-track intro skip and tempo/key window lengths as `planWindows`, but directly calls the DSP; it does not test the Electron coordinator, cache, publication, or multi-window merge. Every item is SHA-256 checked before decoding. A corrupt/missing item or decoder failure makes the run fail rather than silently shrink the denominator.

## Reproduction

The audio and full JSON report are intentionally untracked. On the recorded run, the DSP SHA-256 was `db642859920c731344998e600591dee86ada09878ff684d3073f03fbce02cbbf`; the generated manifest SHA-256 was `400d32719e0d590fb04e6e392c2be431ea17d86b2195ed3afa23d9d23db8abba`. FFmpeg reported `8.0-essentials_build-www.gyan.dev`. The fixed selection is `2*i + (i % 2)` for `i = 0..27` in the Hugging Face dataset's first 60 rows. From the project root, install the locked npm dependencies (`npm ci`) and ensure FFmpeg and Python 3 are available. The following PowerShell/Python commands use only Python's standard library, create an isolated directory, read the original Zenodo labels, verify the published annotation archive MD5, and produce a manifest with audio SHA-256 values. The hosted rows or temporary audio URLs may rate-limit; retry the bounded acquisition later if that occurs. Do not substitute missing rows with different recordings and compare the result to this baseline.

```powershell
$datasetDir = 'test-results/dsp-real/guitarset-v1.1.0-28'
New-Item -ItemType Directory -Force $datasetDir | Out-Null
curl.exe -L --fail --output 'test-results/dsp-real/annotation.zip' 'https://zenodo.org/api/records/3371780/files/annotation.zip/content'
@'
import hashlib, json, pathlib, urllib.error, urllib.request, zipfile, time
root = pathlib.Path('test-results/dsp-real')
target = root / 'guitarset-v1.1.0-28'
archive = root / 'annotation.zip'
assert hashlib.md5(archive.read_bytes()).hexdigest() == 'b39b78e63d3446f2e54ddb7a54df9b10'
z = zipfile.ZipFile(archive)
entries = sorted(name for name in z.namelist() if name.startswith('00_'))
manifest = {
    'schema': 'sonic-real-audio-benchmark/1',
    'dataset': 'GuitarSet v1.1.0, 28 fixed recordings',
    'datasetUrl': 'https://zenodo.org/records/3371780',
    'selection': 'The first 28 of 30 composition slots for player 00; one recording per slot, alternating comp/solo. Acquisition stopped on HTTP 429 before slots 29-30; all acquired recordings included before any DSP run.',
    'samples': []
}
def fetch(url):
    for attempt in range(5):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'SonicV2-benchmark/1'}), timeout=120)
        except urllib.error.HTTPError as error:
            if error.code != 429 or attempt == 4: raise
            time.sleep(min(60, 4 * 2**attempt))
for n in range(28):
    offset = 2*n + (n % 2)
    with fetch(f'https://datasets-server.huggingface.co/rows?dataset=jhartquist/guitarset&config=default&split=train&offset={offset}&length=1') as response:
        row = json.load(response)['rows'][0]['row']
    entry = entries[offset]
    assert row['track_id'] + '.jams' == entry, 'Dataset row ordering changed'
    annotations = json.loads(z.read(entry))
    refs = {a['namespace']: a['data'][0]['value'] for a in annotations['annotations'] if a['namespace'] in ('tempo', 'key_mode')}
    sid = f'r{n+1:03d}'
    dest = target / (sid + '.wav')
    if not dest.exists():
        with fetch(row['audio_mono_mic'][0]['src']) as audio, dest.open('wb') as output:
            while chunk := audio.read(1024*1024): output.write(chunk)
    manifest['samples'].append({
        'id': sid, 'file': dest.name, 'sha256': hashlib.sha256(dest.read_bytes()).hexdigest(),
        'sourceUrl': 'https://zenodo.org/records/3371780',
        'annotationSource': 'https://zenodo.org/records/3371780', 'license': 'CC BY 4.0',
        'upstream': {'dataset': 'GuitarSet v1.1.0', 'jamsEntry': entry,
                     'hfDataset': 'jhartquist/guitarset', 'hfOffset': offset,
                     'hfRevision': '4aca25487bef5cb0d2c4ec146218f9145402a776'},
        'reference': {'tempo': {'kind': 'positive', 'bpm': float(refs['tempo'])},
                      'key': {'kind': 'positive', 'key': refs['key_mode'].replace(':', ' ')}}
    })
(target / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf8')
'@ | python -
node scripts/benchmark-real-audio.mjs --manifest "$datasetDir/manifest.json" --report "$datasetDir/report.json"
```

`node --check scripts/benchmark-real-audio.mjs` passes. The complete report at `test-results/dsp-real/guitarset-v1.1.0-28/report.json` records each independent label, primary output, alternatives, source/license metadata, source hashes, decoder version, and category. An absent corpus is not a successful benchmark: the harness exits **2** for a valid zero-sample manifest and **1** for validation/decode failures. A completed, correctly scored run exits **0** even when acoustic predictions are poor; the categories and denominators are the result, not a pass/fail accuracy threshold.

The next evaluation gap is an independently annotated set of legally usable **drum-heavy and electronic beats**, plus real negative clips with reviewed no-tempo/no-key labels. [Freesound Loop Dataset](https://zenodo.org/records/3967852) has expert-annotated loops, but each clip has its own license and its full audio archive is 8.8 GB; no clips were downloaded or scored here. [MTG-Jamendo](https://mtg.github.io/mtg-jamendo-dataset/) has Creative Commons music but its published tags are genre/instrument/mood rather than independent BPM/key references and its dataset states non-commercial research terms, so it was not used as a Sonic BPM/key benchmark.
