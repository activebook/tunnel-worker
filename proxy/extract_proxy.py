#!/usr/bin/env python3
"""
Extract IP addresses from CF-ProxyIP.csv to proxy.txt
Format: CSV with Chinese header, first column is IP address
"""

import csv

input_file = "CF-ProxyIP.csv"
output_file = "cf-proxy.txt"

with open(input_file, "r", encoding="utf-8-sig") as f_in, \
     open(output_file, "w", encoding="utf-8") as f_out:
    
    reader = csv.reader(f_in)
    next(reader)  # Skip title row
    
    for row in reader:
        if row:  # Skip empty rows
            f_out.write(row[0] + "\n")

print(f"Extracted IPs saved to {output_file}")