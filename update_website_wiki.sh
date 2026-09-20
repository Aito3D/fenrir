#!/bin/bash

cd /opt/claude/projects/fenrir-website
git add .
git commit -m "Updated website"
git push

cd /opt/claude/projects/fenrir-wiki
git add .
git commit -m "Updated Wiki"
git push

#cd /opt/claude/projects/fenrir-sponsors-portal
#git add .
#git commit -m "Updated portal"
#git push
