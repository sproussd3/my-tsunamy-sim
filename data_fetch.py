"""
Deluge data ingestion utilities.

Fetches:
- Tsunami events from NOAA HazEL JSON API
- Flood events from Dartmouth Flood Observatory MasterList (Excel)
- Optional live alerts from GDACS RSS (flood/tsunami)

Outputs:
- deluge_data.json (combined tsunami + flood events)

Dependencies (install manually as needed):
  pip install requests pandas openpyxl
"""

from __future__ import annotations

import io
import json
from typing import Dict, List

import pandas as pd
import requests
import xml.etree.ElementTree as ET


NOAA_URL = "https://www.ngdc.noaa.gov/hazel/hazard-service/api/v1/tsevent?max=20000"
FLOOD_URL = "https://floodobservatory.colorado.edu/Archives/MasterList.xlsx"
GDACS_RSS = "https://www.gdacs.org/xml/rss.xml"
OUTPUT_PATH = "deluge_data.json"


def fetch_tsunamis() -> List[Dict]:
    events: List[Dict] = []
    resp = requests.get(NOAA_URL, timeout=60)
    resp.raise_for_status()
    items = resp.json().get("items", [])

    for item in items:
        lat = item.get("latitude")
        lng = item.get("longitude")
        if lat is None or lng is None:
            continue
        events.append(
            {
                "id": f"tsu_{item.get('id')}",
                "type": "tsunami",
                "year": item.get("year"),
                "location": {
                    "lat": lat,
                    "lng": lng,
                    "region": item.get("country", "Unknown"),
                },
                "metrics": {
                    "magnitude": item.get("eqMagnitude"),
                    "max_water_height_m": item.get("maxWaterHeight", 0),
                    "deaths": item.get("deathsAmountOrder", 0),
                },
                "cause": item.get("causeCode", "Unknown"),
            }
        )
    return events


def fetch_floods() -> List[Dict]:
    events: List[Dict] = []
    resp = requests.get(FLOOD_URL, timeout=120)
    resp.raise_for_status()
    df = pd.read_excel(io.BytesIO(resp.content))

    for _, row in df.iterrows():
        lat = row.get("Centroid Y")
        lng = row.get("Centroid X")
        if pd.isna(lat) or pd.isna(lng):
            continue
        events.append(
            {
                "id": f"fld_{row.get('DFO#', 'unk')}",
                "type": "flood",
                "year": row.get("Began"),
                "location": {
                    "lat": float(lat),
                    "lng": float(lng),
                    "region": row.get("Country", "Unknown"),
                },
                "metrics": {
                    "severity": row.get("Severity", 0),
                    "area_sq_km": row.get("Area", 0),
                    "displaced": row.get("Displaced", 0),
                },
                "cause": row.get("MainCause", "Unknown"),
            }
        )
    return events


def check_future_threats() -> List[Dict]:
    """Fetch live flood/tsunami alerts from GDACS RSS."""
    resp = requests.get(GDACS_RSS, timeout=30)
    resp.raise_for_status()

    alerts: List[Dict] = []
    root = ET.fromstring(resp.content)
    for item in root.findall("./channel/item"):
        title_el = item.find("title")
        lat_el = item.find("{http://www.w3.org/2003/01/geo/wgs84_pos#}lat")
        lng_el = item.find("{http://www.w3.org/2003/01/geo/wgs84_pos#}long")
        link_el = item.find("link")
        if not (title_el is not None and lat_el is not None and lng_el is not None):
            continue
        title = title_el.text or ""
        if "flood" not in title.lower() and "tsunami" not in title.lower():
            continue
        alerts.append(
            {
                "event": title,
                "lat": float(lat_el.text),
                "lng": float(lng_el.text),
                "link": link_el.text if link_el is not None else "",
            }
        )
    return alerts


def fetch_and_convert_all() -> List[Dict]:
    all_events: List[Dict] = []
    print("Starting Deluge data scraper")

    try:
        tsu = fetch_tsunamis()
        all_events.extend(tsu)
        print(f"  Tsunamis fetched: {len(tsu)}")
    except Exception as exc:  # noqa: BLE001
        print(f"  Error fetching tsunamis: {exc}")

    try:
        floods = fetch_floods()
        all_events.extend(floods)
        print(f"  Floods fetched: {len(floods)}")
    except Exception as exc:  # noqa: BLE001
        print(f"  Error fetching floods: {exc}")

    print(f"Total events compiled: {len(all_events)}")
    return all_events


def save_events(events: List[Dict], path: str = OUTPUT_PATH) -> None:
    with open(path, "w", encoding="utf-8") as fp:
        json.dump(events, fp, separators=(",", ":"))
    print(f"Wrote {len(events)} events to {path}")


if __name__ == "__main__":
    data = fetch_and_convert_all()
    save_events(data)
    try:
        alerts = check_future_threats()
        print(f"Live alerts (flood/tsunami): {len(alerts)}")
    except Exception as exc:  # noqa: BLE001
        print(f"Error fetching live alerts: {exc}")
