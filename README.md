# The Grove

The Grove helps people in Singapore find home-based businesses. Customers discover businesses,
order or book, and log their visits. Each visit to a *new* business on the same day earns $1 cash
back, so customers are rewarded for trying more local shops. Business owners get a studio with
their storefront, menu, opening hours, bookings, customers, insights and finances.

In production it runs on AWS: S3 for the website, API Gateway, Python Lambda functions and
DynamoDB. **You don't need an AWS account to try it.** The repository includes a small local
server that runs the same Lambda code on your computer, with an in-memory database in place of
DynamoDB.

---

## Quickest way: run it in your browser (GitHub Codespaces)

Nothing to install. You need a free GitHub account.

1. On this repository's GitHub page, click the green **Code** button → **Codespaces** tab →
   **Create codespace on main**.
2. Wait about 2 minutes while it sets up. The site starts by itself and opens in a new browser tab.
   If the tab doesn't open, click the **Ports** tab at the bottom of the codespace and click the 🌐 icon
   next to port **8080**. (If your browser blocked a pop-up, allow it.)
3. Log in with one of the [demo logins](#demo-logins) below.

If the site isn't running (for example after the codespace was paused), type `python run_local.py` in the
terminal at the bottom and press Enter. When you're done, stop the codespace from
[github.com/codespaces](https://github.com/codespaces) (personal GitHub accounts get a free monthly allowance).

## How to run it on your own computer (free, no AWS account)

### What you need

- **Python 3.10 or newer.** Check with `python --version` (on macOS it's usually `python3 --version`).
  If you don't have it, install it from [python.org](https://www.python.org/downloads/).
- An internet connection, only for the business photos and map tiles.

### Steps

1. Download the repository: on GitHub, click **Code → Download ZIP** and unzip it, or run
   `git clone <this repository's URL>`.
2. Open a terminal in the unzipped folder (the one that contains `run_local.py`).
3. Install the one dependency:

   ```bash
   pip install boto3
   ```

   (Use `pip3 install boto3` or `python -m pip install boto3` if `pip` isn't found.)
4. Start the site:

   ```bash
   python run_local.py
   ```

   On macOS use `python3 run_local.py`. On Windows, `py run_local.py` also works.

Your browser opens **http://localhost:8080**. If it doesn't, open that address yourself.
Leave the terminal open while you use the site, and press **Ctrl+C** in it to stop.

The terminal shows:

```
Seeded 26 businesses
Website  http://localhost:8080   (Ctrl+C to stop)
Demo logins (password grove1234):  customer customer@demo.sg   business owner owner@demo.sg
```

### Demo logins

The local site starts with 26 sample businesses and two ready-made accounts (password `grove1234`):

| Login | What you see |
|---|---|
| `customer@demo.sg` | A customer with no visits yet, ready to try ordering, booking and cash back. |
| `owner@demo.sg` | The owner of *Sunday Bakehouse*. Its studio already has 6 sample customers and 7 visits, so Customers, Insights and Finances show real numbers. Click **Open business studio** at the bottom-left after logging in. |

You can also sign up with any made-up email; nothing is sent.

### Things to try

**As a customer** (`customer@demo.sg`)

1. **Discover** shows the map and "Recommended for you". Pick a category chip, then open a business.
2. On a **Food & Beverage** business (for example *Sunday Bakehouse*), press **Place an order**, tick a
   product and press **Place order**. Then, back on the storefront, press **Collected it? Log your visit**.
3. Order from and log a visit at a **second, different** business: the receipt shows **+$1.00 cash back**,
   and **My wallet** shows the balance and your chain.
4. On a **Health & Beauty** business (for example *Dew Ritual*), press **Book appointment**, pick a free
   slot and send the request. It appears under **Bookings** as waiting for the business.

**As a business owner** (`owner@demo.sg`)

1. Log in, then press **Open business studio** at the bottom-left.
2. **Overview** lists new orders and booking requests. Orders placed at Sunday Bakehouse from the customer
   account appear here under **Waiting for you**.
3. **Customers**, **Insights** and **Finances** show the sample activity.
4. **My storefront** edits the menu, prices and opening hours.

To start a business of your own, log in as a customer and use the account menu (your name at the
bottom-left) → **Sign up as a business**. Enter any 6-digit Singapore postal code, such as `117417`.
The postal code only sets the approximate area on the map; the street address stays private.

### Good to know

- **Data is kept in memory.** Everything you add disappears when you stop `run_local.py`, and the
  sample businesses, demo logins and sample visits come back fresh each time.
- **Opening hours use Singapore time.** In this local copy the sample shops that sell products are open
  8:00am–11:00pm every day so orders can be tried; orders can only be placed while a shop is open.
- **"Use my location"** on Discover works on `localhost`; your browser asks for permission first.

### If something goes wrong

| What you see | What to do |
|---|---|
| `boto3 is missing` | Run `pip install boto3` (or `python -m pip install boto3`) and start again. |
| `Address already in use` | Another program (or an earlier `run_local.py`) is using port 8080. Close it, or run `python run_local.py --port 8090` and open http://localhost:8090. |
| The site says "We couldn't reach The Grove" | The terminal running `run_local.py` was closed or stopped. Start it again. |
| `python` isn't recognised (Windows) | Use `py run_local.py`, or reinstall Python from python.org and tick "Add python.exe to PATH". |
| Photos or the map are grey | The computer is offline. Everything else still works. |

---

## How it's built

```
Browser ─► S3 (frontend/) ─► API Gateway HTTP API ─► Python Lambdas (lambdas/) ─► DynamoDB
```

| Folder | What's in it |
|---|---|
| `frontend/` | The website: plain HTML, CSS and JavaScript, no build step. `config.js` says where the API is; it picks the local API automatically when the page is opened from `localhost`. |
| `lambdas/` | One folder per Lambda function (`lambda_function.py`), plus the shared `common.py` that every function is deployed with. |
| `run_local.py` | Serves the website and the local API together on one port, and adds the demo logins and sample visits. |
| `.devcontainer/` | Lets the repository run in GitHub Codespaces with one click. |
| `tools/local_api.py` | Runs the Lambda functions with the same routes as API Gateway (`run_local.py` serves them under `/api`). |
| `tools/fake_dynamodb.py` | The in-memory stand-in for DynamoDB used by the local run. |
| `tools/seed_businesses.json` | The 26 sample businesses, with menus and opening hours. |
| `tools/build_lambdas.sh` | Zips each function with `common.py` for uploading to AWS Lambda. |
| `SETUP.md` | The full AWS deployment guide. |

## Running it on AWS instead (optional)

The local run uses the same Lambda code as the live site. To deploy the real AWS version to your own account,
open **AWS CloudShell** in region **us-east-1**, upload a zip of this repository (**Actions → Upload file**), then:

```bash
unzip DIP_07-main.zip -d grove && cd grove/*/
python3 tools/deploy_aws.py
```

It creates the five DynamoDB tables, a role for the functions, every Lambda function, the API Gateway routes,
a private S3 bucket behind a CloudFront HTTPS address, and the sample businesses and demo logins, then prints
the website address. Run it again after a code change to update everything. `SETUP.md` explains each piece
if you'd rather set it up by hand.
