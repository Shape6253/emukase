# emukase

Android handhelds are getting more and more popular. But buying one doesn't mean you can actually start playing right out of the box.
First, you've got a couple of two-hour YouTube tutorials to sit through, emulator files to hunt down, and a bunch of simple but incredibly boring setup steps to deal with.
It's kind of like a Kinder Surprise: you have to assemble the toy before you can actually play with it. Except the assembly takes hours.

**[emukase](https://emukase.com)** is an attempt to fix that.

The idea is simple: take care of all the tedious emulator setup so you can skip straight to copying your ROMs and playing games.*

<sub>* Some emulators still require BIOS files, firmware, keys, and other extras. emukase doesn't distribute any of these files - you'll need to provide your own.</sub>

## Getting started

1. Go to **[emukase.com](https://emukase.com)**.
2. Connect your Android handheld to your computer via USB with ADB debugging enabled.
3. Select your device and follow the instructions.
4. Once setup is complete, just add your ROMs and you're good to go.

<sub>**AYANEO owners:** USB debugging is enabled by default, so simply plugging your handheld in should be enough.</sub>

## Project status

**Early alpha.** Expect bugs, rough edges, and things that might not work quite as expected.

Right now, I only have an **AYANEO KONKR Pocket FIT**, so that's where all development and testing happens.
I'd really appreciate some help from the community, especially anyone with **Retroid** or **AYN** devices who's willing to give emukase a try.

If something goes wrong, feel free to [open an issue](https://github.com/Shape6253/emukase/issues). Just include your device model, a short description of what happened, and the installation log.
Suggestions, ideas, and pull requests are more than welcome too!

## Running locally

Don't want to use the hosted version? No problem. You can run emukase locally.

You'll need [Bun](https://bun.sh) installed.

1. Clone the repository: `git clone https://github.com/Shape6253/emukase.git`
2. Enter the project directory: `cd emukase`
3. Install dependencies and start the development server
```sh
bun install
bun run dev
```

Open the local URL shown in your terminal using a Chromium-based browser, connect your handheld, and you're good to go.

Once the dependencies are installed, the app itself can run locally without an internet connection. Emulator setup still requires internet access.

## License

emukase is open source and licensed under [GPL-3.0](LICENSE).
