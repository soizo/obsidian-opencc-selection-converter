# Fixed OpenCC dictionary fixtures

`formats.txt` is the hand-authored source. `formats.ocd` and `formats.ocd2` were generated once with the `opencc_dict` target built from the pinned official OpenCC commit `025f371dc76b598d77384fbdab90c937471844d8` (tag `ver.1.4.2`):

```sh
opencc_dict -i formats.txt -o formats.ocd -f text -t ocd
opencc_dict -i formats.txt -o formats.ocd2 -f text -t ocd2
```

SHA-256:

- `formats.txt`: `80becefe9e4185d688d9a0991e3ef1cea575ec9435974ee910546369c2a0b99f`
- `formats.ocd`: `61fb405be9d047b5c4c5ef67ac2ca4e188c019d7e5ae20ccdde62e09e65c8b2c`
- `formats.ocd2`: `7e8ce53b9bbc8ce4b5132fde5931457263ac48e49763026c15701119cb0de732`

`length-risk.txt` and its `.ocd` / `.ocd2` siblings use the same pinned generator and commands (substitute `length-risk` for `formats`). They include one length-changing default (`甲 → 甲乙`) and one equal-length default with a longer unused alternative (`乙 → 丙`, alternative `丙丁`):

- `length-risk.txt`: `af8f80c67dafdd53a0b59556cb5b18987340871b26faeed84ffe6bdf5b77ff25`
- `length-risk.ocd`: `55c485e5ad60021219f7a2201d35c1ea0b04f4740b45f55a7da252f2f4cae479`
- `length-risk.ocd2`: `9c9d3b6671fe486e0cb29ce741a9de85f095f87b0f6219570167a9f6d19d0351`

These small files verify decoding, tracing and enumeration. They are not product dictionaries and are absent from production builds.
