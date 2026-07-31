#include <iostream>
using namespace std;

/*
January (31 days)
February (28 days in a common year and 29 days in leap years)
March (31 days)
April (30 days)
May (31 days)
June (30 days)
July (31 days)
August (31 days)
September (30 days)
October (31 days)
November (30 days)
December (31 days)
*/

const char* MONTHS[] = { "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December" };

bool is_valid_date(int day, int month, int year);
int get_days(int month, int year);

int main() {
    cout << boolalpha << is_valid_date(1, 8, 2023) << endl;
    for (size_t i = 0; i < 12; i++) {
        cout << MONTHS[i] << " (" << get_days(i + 1, 1200) << " days)" << endl;
    }
    return 0;
}

int get_days(int month, int year) {
    return month >= 1 && month <= 12 ? ((month > 7 ? month + 1 : month) % 2 == 0 ? (month == 2 ? (year % 100 != 0 && year % 4 == 0 || year % 400 == 0 ? 29 : 28) : 30) : 31) : false;
    /*
    if (month < 1 || month > 12)
        return false;

    return (month > 7 ? month + 1 : month) % 2 == 0
    ?
    (
        month == 2
        ? 
        (
            year % 100 != 0 && year % 4 == 0 || year % 400 == 0
            ?
            29
            :
            28
        )
        :
        30
    )
    :
    31;
    */
}

bool is_valid_date(int day, int month, int year) {
    // return month >= 1 && month <= 12 && day >= 1 ? ((month > 7 ? month + 1 : month) % 2 == 0 ? (month == 2 ? (year % 100 != 0 && year % 4 == 0 || year % 400 == 0 ? day <= 29 : day <= 28) : day <= 30) : day <= 31) : false;

    // every year should have at least 1 month and at most 12 months and every month should have at least 1 day.
    if (month < 1 || month > 12 || day < 1)
        return false;

            // Check is month from 1-12 even and create a offset to month value when it is more than 7(August and onwards)
    return (month > 7 ? month + 1 : month) % 2 == 0
    ?
    (
        // February sepcial case check
        month == 2
        ? 
        (
            // Leap year check
            year % 100 != 0 && year % 4 == 0 || year % 400 == 0
            ?
            // is leap year
            day <= 29
            :
            // not leap year
            day <= 28
        )
        :
        // Month with even value except February should have at most 30 days.
        day <= 30
    )
    :
    // Month with odd value should have at most 31 days.
    day <= 31;
}