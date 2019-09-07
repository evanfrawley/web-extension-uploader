const puppeteer = require('puppeteer');
const fetch = require('node-fetch');
const { URLSearchParams } = require('url');
const { readFileSync, createReadStream, statSync } = require('fs');
const AWS = require('aws-sdk');
const S3 = require('aws-sdk/clients/s3');

const {
    CHROME_CLIENT_ID,
    CHROME_CLIENT_SECRET,
    CHROME_REFRESH_TOKEN,
    MOZILLA_USERNAME,
    MOZILLA_PASSWORD,
    AWS_ACCESS_ID,
    AWS_ACCESS_SECRET,
    INPUT_CHROME_STORE_ID,
    INPUT_MOZILLA_ADDON_ID,
    INPUT_SRC_DIR,
    INPUT_ZIP_NAME,
    INPUT_ZIP_SRC_NAME,
} = process.env;

AWS.config.update({
    accessKeyId: AWS_ACCESS_ID,
    secretAccessKey: AWS_ACCESS_SECRET
});

const zipPath = `${INPUT_SRC_DIR}${INPUT_ZIP_NAME}`;
const zipSourcePath = `${INPUT_SRC_DIR}${INPUT_ZIP_SRC_NAME}`;

function timeout(ms) {
    console.log(`Waiting: ${ms}ms`);
    return new Promise(resolve => setTimeout(resolve, ms));
}

function msg(phrase) {
    let s = "####";
    for (let i = 0; i < phrase.length; i++) {
        s = s + "#";
    }
    console.log(s);
    console.log(`### ${phrase}`);
    console.log(s);
    console.log();
}

async function uploadToS3(imgPath) {
    const img = await readFileSync(imgPath);

    const base64data = new Buffer(img, 'binary');
    const s3 = new S3();

    const now = new Date();

    const timestampedFilename = `${now.getFullYear()}_${now.getMonth()}_${now.getDay()}_${now.getHours()}_${now.getMinutes()}_${now.getSeconds()}_${imgPath}`;

    s3.putObject({
        Bucket: 'kanga-debug',
        Key: timestampedFilename,
        Body: base64data,
        ACL: 'public-read'
    },function (resp) {
        console.log(arguments);
        console.log('Successfully uploaded package.');
    });
    return timeout(1000);
}

async function uploadFirefox() {
    msg("Beginning Firefox");

    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    console.log(`https://addons.mozilla.org/en-US/developers/addon/${INPUT_MOZILLA_ADDON_ID}/versions/submit/`);
    await page.goto(`https://addons.mozilla.org/en-US/developers/addon/${INPUT_MOZILLA_ADDON_ID}/versions/submit/`);
    
    await timeout(10000);

    // Logging in
    await page.focus("input[name='email']");
    await page.keyboard.type(MOZILLA_USERNAME, {delay: 100});
    await page.focus("#password");
    await page.keyboard.type(MOZILLA_PASSWORD, {delay: 100});
    await page.evaluate(() => {
        document.getElementById("submit-btn").click();
    });


    await timeout(15000);
    msg("Logged in");

    // Uploading built version
    const [builtFileChooser] = await Promise.all([
      page.waitForFileChooser(),
      page.click('#upload-addon'),
    ]);
    await builtFileChooser.accept([zipPath]);
    await timeout(15000);
    await page.click("#submit-upload-file-finish");
    msg("Clicked submit");
    await timeout(15000);

    console.log("could not find out what to click next!!1");
    await page.screenshot({path: "error.png"})
        .then(() => {
            return uploadToS3("error.png")
        });

    // Upload the source
    const queriesToAttempt = ["#id_has_source", "label[for='id_has_source_0']", "#id_has_source_0"];
    let clicked = false;
    await Promise.all(queriesToAttempt.map(async (query) => {
        if (!clicked) {
            let sourceButtonConfirm = await page.$(query);
            if (sourceButtonConfirm && sourceButtonConfirm.children && sourceButtonConfirm.children.length > 0) {
                sourceButtonConfirm.children[0].click();
                clicked = true;
            }
        }
        return Promise.resolve();
    }))
    .catch(() => {
        console.log("could not find out what to click next");
        return page.screenshot({path: "error.png"})
            .then(() => {
                return uploadToS3("error.png")
            })
            .then((res) => {
                console.log(res);
                process.exit(1);
            });
    });

    await timeout(1000);

    const [sourceFileChooser] = await Promise.all([
      page.waitForFileChooser(),
      page.click('#id_source'),
    ]);
    await sourceFileChooser.accept([zipSourcePath]);
    await timeout(15000);
    await page.evaluate(() => {
      document.querySelector("button[type='submit']").click();
    });
    await timeout(15000);
  
    // Patch notes
    await page.focus("#id_release_notes_0");
    await page.keyboard.type('- Bug fixes and improvements', {delay: 100});
    await page.evaluate(() => {
      document.querySelector("button[type='submit']").click();
    });
    await timeout(15000);

    await browser.close();  

    msg("🎉 Upload to Firefox completed 🎉");
}

async function getRefreshedChromeToken() {
    msg("Getting Chrome Access Token");

    const params = new URLSearchParams();
    params.append("refresh_token", CHROME_REFRESH_TOKEN);
    params.append("client_secret", CHROME_CLIENT_SECRET);
    params.append("client_id", CHROME_CLIENT_ID);
    params.append("grant_type", "refresh_token");
    
    const token = await fetch("https://www.googleapis.com/oauth2/v4/token", { method: "POST", body: params })
        .then(res => res.json())
        .then(json => json.access_token);

    return token;
}

function getChromeHeaders(token) {
    return {
        "x-goog-api-version": 2,
        "Authorization": `Bearer ${token}`,
    }
}

async function uploadNewChromeVersion(token) {
    const stream = createReadStream(zipPath);
    const stats = statSync(zipPath);
    const fileSizeInBytes = stats.size;

    const headers = getChromeHeaders(token);
    headers["Content-Length"] = fileSizeInBytes;
    const payload =  { 
        method: "PUT", 
        body: stream, 
        headers, 
    };

    return fetch(`https://www.googleapis.com/upload/chromewebstore/v1.1/items/${INPUT_CHROME_STORE_ID}`, payload)
        .then(res => {
            if (res.status >= 300) {
                console.error(JSON.stringify(res));
                throw new Error(`got status code: ${res.status}`);
            }
            return res;
        })
        .then(res => res.json())
        .then(() => {
            msg(`Uploaded Chrome Version`)
        });

}

async function publishNewChromeVersion(token) {
    const payload =  { 
        method: "POST", 
        headers: getChromeHeaders(token), 
    };

    return fetch(`https://www.googleapis.com/chromewebstore/v1.1/items/${INPUT_CHROME_STORE_ID}/publish`, payload)
        .then(res => {
            if (res.status >= 300) {
                console.error(JSON.stringify(res));
                throw new Error(`got status code: ${res.status}`);
            }
            return res;
        })
        .then(res => res.json())
        .then(json => {
            console.log(json);
            msg(`Published Chrome Version`);
        });
}

async function uploadChrome() {
    msg("Beginning Chrome");
    const accessToken = await getRefreshedChromeToken();

    await uploadNewChromeVersion(accessToken);
    await timeout(1000);
    await publishNewChromeVersion(accessToken);

    msg("🎉 Upload to Chrome completed 🎉");
}

(async () => {
    if (!INPUT_SRC_DIR) {
        console.log("You must set a `src_dir` as an input");
        process.exit(1);
    }

    if (!INPUT_ZIP_NAME) {
        console.log("You must set a `zip_name` as an input");
        process.exit(1);
    }

    try {
        if (INPUT_CHROME_STORE_ID && CHROME_CLIENT_ID && CHROME_CLIENT_SECRET && CHROME_REFRESH_TOKEN) {
            // await uploadChrome();
        }
        if (INPUT_MOZILLA_ADDON_ID && MOZILLA_USERNAME && MOZILLA_PASSWORD) {
            await uploadFirefox();
        }
    } catch (e) {
        console.log(e);
        process.exit(1);
    }

    msg("🎉 Both finished without error! 🎉");
    process.exit(0);
})();
